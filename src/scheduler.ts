import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, MutableRef, Scope } from "effect";
import { JscpdClockLive, jscpdClockLive } from "./effect/clock.js";
import {
  makeEffectScopeAtApplicationBoundary,
  runEffectPromiseAtApplicationBoundary,
  runEffectSyncAtApplicationBoundary,
} from "./effect/runtime-boundary.js";
import { type JscpdClock, JscpdClock as JscpdClockTag } from "./effect/services.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "./types.js";

export interface JscpdAutomaticScanContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  /** True only while this run still owns the latest mutation in the active lifecycle scope. */
  readonly isCurrent: () => boolean;
}

export type JscpdAutomaticScanDisposition = "attempted" | "deferred";

export type JscpdAutomaticScanTask = (
  context: JscpdAutomaticScanContext,
) => Promise<JscpdAutomaticScanDisposition>;

export type JscpdAutomaticScanEffectTask<R = never, E = never> = (
  context: JscpdAutomaticScanContext,
) => Effect.Effect<JscpdAutomaticScanDisposition, E, R>;

export type JscpdExplicitRunResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "closed" };

export interface JscpdScanSchedulerSnapshot {
  readonly changedGeneration: number;
  readonly attemptedGeneration: number;
  readonly automatic: "idle" | "pending" | "active";
  readonly closed: boolean;
}

export interface JscpdScanScheduler {
  /** Advance the latest attributable mutation generation. */
  markChanged(): number;
  /** Coalesce one request; a deferred disposition leaves its generation retryable. */
  requestAutomatic(task: JscpdAutomaticScanTask): boolean;
  /** Temporary Effect-native path used by migrated automatic checks before M7.7. */
  requestAutomaticEffect?(task: JscpdAutomaticScanEffectTask<never, unknown>): boolean;
  /** Explicit work supersedes only scheduler-owned automatic work. */
  runExplicit<T>(task: () => Promise<T>): Promise<JscpdExplicitRunResult<T>>;
  /** Abort and discard pending automatic work without consuming its generation. */
  cancelAutomatic(): void;
  /** Start a fresh active-branch scope while keeping the scheduler reusable. */
  reset(): void;
  /** Prevent future work, interrupt automatic ownership, and await its settlement. */
  dispose(): Promise<void>;
  snapshot(): JscpdScanSchedulerSnapshot;
}

interface JscpdScanSchedulerEffectService {
  readonly markChanged: Effect.Effect<number>;
  readonly requestAutomatic: <R, E>(
    task: JscpdAutomaticScanEffectTask<R, E>,
  ) => Effect.Effect<boolean, never, R>;
  readonly runExplicit: <T, E, R>(
    task: Effect.Effect<T, E, R>,
  ) => Effect.Effect<JscpdExplicitRunResult<T>, E, R>;
  readonly cancelAutomatic: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<JscpdScanSchedulerSnapshot>;
}

export const JscpdScanScheduling = Context.GenericTag<JscpdScanSchedulerEffectService>(
  "pi-jscpd/effect/ScanScheduling",
);

interface PendingAutomaticScan {
  readonly epoch: number;
  readonly generation: number;
  readonly task: JscpdAutomaticScanEffectTask;
}

interface ActiveAutomaticScan extends PendingAutomaticScan {
  readonly controller: AbortController;
  readonly fiber: Fiber.RuntimeFiber<JscpdAutomaticScanDisposition, never>;
}

interface SchedulerState {
  readonly epoch: number;
  readonly changedGeneration: number;
  readonly attemptedGeneration: number;
  readonly pending?: PendingAutomaticScan;
  readonly active?: ActiveAutomaticScan;
  readonly startQueued: boolean;
  readonly closed: boolean;
}

const INITIAL_SCHEDULER_STATE: SchedulerState = Object.freeze({
  epoch: 0,
  changedGeneration: 0,
  attemptedGeneration: 0,
  startQueued: false,
  closed: false,
});

/**
 * Effect owns automatic scheduling and cancellation. Scan processes remain serialized by the
 * jscpd adapter. The queue is bounded to one active and one latest-generation pending request.
 */
export function createJscpdScanScheduler(): JscpdScanScheduler {
  const scope = makeEffectScopeAtApplicationBoundary();
  const owner = new ScanSchedulerOwner(scope, jscpdClockLive);
  const service = scanSchedulerEffectServiceFor(owner);
  let disposePromise: Promise<void> | undefined;
  return {
    markChanged: () => runEffectSyncAtApplicationBoundary(service.markChanged),
    requestAutomatic: (task) =>
      runEffectSyncAtApplicationBoundary(
        service.requestAutomatic((context) => automaticPromiseTaskEffect(task, context)),
      ),
    requestAutomaticEffect: (task) =>
      runEffectSyncAtApplicationBoundary(service.requestAutomatic(task)),
    runExplicit: (task) =>
      runEffectPromiseAtApplicationBoundary(
        service.runExplicit(
          Effect.tryPromise({
            try: task,
            catch: (error) => error,
          }),
        ),
      ),
    cancelAutomatic: () => runEffectSyncAtApplicationBoundary(service.cancelAutomatic),
    reset: () => runEffectSyncAtApplicationBoundary(service.reset),
    dispose: () => {
      disposePromise ??= runEffectPromiseAtApplicationBoundary(
        service.dispose.pipe(Effect.zipRight(Scope.close(scope, Exit.void))),
      );
      return disposePromise;
    },
    snapshot: () => runEffectSyncAtApplicationBoundary(service.snapshot),
  };
}

/** Build a scheduler whose background fibers are children of the extension's managed scope. */
export function createJscpdScanSchedulerLayer(clockLayer = JscpdClockLive) {
  return Layer.scoped(
    JscpdScanScheduling,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const clock = yield* JscpdClockTag;
      const owner = new ScanSchedulerOwner(scope, clock);
      yield* Effect.addFinalizer(() => owner.disposeEffect());
      return scanSchedulerEffectServiceFor(owner);
    }),
  ).pipe(Layer.provide(clockLayer));
}

class ScanSchedulerOwner {
  readonly #scope: Scope.Scope;
  readonly #clock: JscpdClock;
  readonly #state = MutableRef.make<SchedulerState>(INITIAL_SCHEDULER_STATE);

  constructor(scope: Scope.Scope, clock: JscpdClock) {
    this.#scope = scope;
    this.#clock = clock;
  }

  markChangedEffect(): Effect.Effect<number> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      if (current.closed) return Effect.succeed(current.changedGeneration);
      if (current.changedGeneration < Number.MAX_SAFE_INTEGER) {
        const changedGeneration = current.changedGeneration + 1;
        MutableRef.set(this.#state, { ...current, changedGeneration });
        return Effect.succeed(changedGeneration);
      }
      return this.cancelAutomaticEffect().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const reset = MutableRef.get(this.#state);
            MutableRef.set(this.#state, {
              ...reset,
              changedGeneration: 1,
              attemptedGeneration: 0,
            });
          }),
        ),
        Effect.as(1),
      );
    });
  }

  requestAutomaticEffect<R, E>(
    task: JscpdAutomaticScanEffectTask<R, E>,
  ): Effect.Effect<boolean, never, R> {
    return Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.suspend(() => {
          const current = MutableRef.get(this.#state);
          if (current.closed || current.changedGeneration <= current.attemptedGeneration) {
            return Effect.succeed(false);
          }
          const generation = current.changedGeneration;
          if (hasCurrentRequestFor(current, generation)) return Effect.succeed(false);
          const preparedTask: JscpdAutomaticScanEffectTask = (scanContext) =>
            task(scanContext).pipe(
              Effect.provide(context),
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.interrupt
                  : Effect.succeed("attempted" as const),
              ),
            );
          MutableRef.set(this.#state, {
            ...current,
            pending: Object.freeze({ epoch: current.epoch, generation, task: preparedTask }),
          });
          return this.queueStartEffect().pipe(Effect.as(true));
        }),
      ),
    );
  }

  runExplicitEffect<T, E, R>(
    task: Effect.Effect<T, E, R>,
  ): Effect.Effect<JscpdExplicitRunResult<T>, E, R> {
    return Effect.suspend(() => {
      if (MutableRef.get(this.#state).closed) return Effect.succeed(closedExplicitResult());
      return this.cancelAutomaticEffect().pipe(
        Effect.flatMap(() =>
          MutableRef.get(this.#state).closed
            ? Effect.succeed(closedExplicitResult())
            : task.pipe(
                Effect.map((value) => Object.freeze({ status: "completed" as const, value })),
              ),
        ),
      );
    });
  }

  cancelAutomaticEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      current.active?.controller.abort();
      MutableRef.set(this.#state, {
        ...current,
        epoch: current.epoch + 1,
        pending: undefined,
      });
      return current.active ? Fiber.interruptFork(current.active.fiber) : Effect.void;
    });
  }

  resetEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (MutableRef.get(this.#state).closed) return Effect.void;
      return this.cancelAutomaticEffect().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const current = MutableRef.get(this.#state);
            MutableRef.set(this.#state, {
              ...current,
              changedGeneration: 0,
              attemptedGeneration: 0,
            });
          }),
        ),
      );
    });
  }

  disposeEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      if (current.closed && !current.active) return Effect.void;
      current.active?.controller.abort();
      MutableRef.set(this.#state, {
        ...current,
        epoch: current.epoch + 1,
        pending: undefined,
        closed: true,
      });
      return current.active
        ? Fiber.interrupt(current.active.fiber).pipe(Effect.asVoid)
        : Effect.void;
    });
  }

  snapshot(): JscpdScanSchedulerSnapshot {
    const state = MutableRef.get(this.#state);
    return Object.freeze({
      changedGeneration: state.changedGeneration,
      attemptedGeneration: state.attemptedGeneration,
      automatic: state.active ? "active" : state.pending ? "pending" : "idle",
      closed: state.closed,
    });
  }

  private queueStartEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      if (current.startQueued || current.closed || current.active || !current.pending) {
        return Effect.void;
      }
      MutableRef.set(this.#state, { ...current, startQueued: true });
      return Effect.forkIn(
        this.#clock.sleep(0).pipe(Effect.zipRight(this.startPendingEffect())),
        this.#scope,
      ).pipe(Effect.asVoid);
    });
  }

  private startPendingEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      MutableRef.set(this.#state, { ...current, startQueued: false });
      const candidate = current.pending;
      if (current.closed || current.active || !candidate) return Effect.void;
      MutableRef.set(this.#state, { ...MutableRef.get(this.#state), pending: undefined });
      if (
        candidate.epoch !== current.epoch ||
        candidate.generation <= current.attemptedGeneration ||
        candidate.generation > current.changedGeneration
      ) {
        return this.queueStartEffect();
      }
      return this.launchAutomaticEffect(candidate);
    });
  }

  private launchAutomaticEffect(candidate: PendingAutomaticScan): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const controller = new AbortController();
      const gate = yield* Deferred.make<void>();
      const program = Deferred.await(gate).pipe(
        Effect.zipRight(this.runAutomaticTaskEffect(candidate, controller)),
      );
      const fiber = yield* Effect.forkIn(program, this.#scope);
      const current = MutableRef.get(this.#state);
      if (current.closed || current.epoch !== candidate.epoch) {
        controller.abort();
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.interruptFork(fiber);
        return;
      }
      MutableRef.set(this.#state, {
        ...current,
        active: Object.freeze({ ...candidate, controller, fiber }),
      });
      yield* Deferred.succeed(gate, undefined);
    });
  }

  private runAutomaticTaskEffect(
    candidate: PendingAutomaticScan,
    controller: AbortController,
  ): Effect.Effect<JscpdAutomaticScanDisposition> {
    const context = Object.freeze({
      generation: candidate.generation,
      signal: controller.signal,
      isCurrent: () => this.isCurrent(candidate, controller),
    });
    return candidate.task(context).pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed("attempted" as const),
      ),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      Effect.onExit((exit) => this.finishAutomaticEffect(candidate, controller, exit)),
    );
  }

  private finishAutomaticEffect(
    candidate: PendingAutomaticScan,
    controller: AbortController,
    exit: Exit.Exit<JscpdAutomaticScanDisposition, never>,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.#state);
      if (current.active?.controller !== controller) return Effect.void;
      const disposition = Exit.isSuccess(exit) ? exit.value : undefined;
      const attemptedGeneration =
        disposition === "attempted" &&
        !current.closed &&
        candidate.epoch === current.epoch &&
        !controller.signal.aborted
          ? Math.max(current.attemptedGeneration, candidate.generation)
          : current.attemptedGeneration;
      MutableRef.set(this.#state, {
        ...current,
        active: undefined,
        attemptedGeneration,
      });
      return this.queueStartEffect();
    });
  }

  private isCurrent(candidate: PendingAutomaticScan, controller: AbortController): boolean {
    const state = MutableRef.get(this.#state);
    return (
      !state.closed &&
      !controller.signal.aborted &&
      candidate.epoch === state.epoch &&
      candidate.generation === state.changedGeneration
    );
  }
}

function hasCurrentRequestFor(state: SchedulerState, generation: number): boolean {
  return (
    (state.active?.epoch === state.epoch && state.active.generation >= generation) ||
    (state.pending?.epoch === state.epoch && state.pending.generation >= generation)
  );
}

function scanSchedulerEffectServiceFor(owner: ScanSchedulerOwner): JscpdScanSchedulerEffectService {
  return {
    markChanged: Effect.suspend(() => owner.markChangedEffect()),
    requestAutomatic: (task) => owner.requestAutomaticEffect(task),
    runExplicit: (task) => owner.runExplicitEffect(task),
    cancelAutomatic: Effect.suspend(() => owner.cancelAutomaticEffect()),
    reset: Effect.suspend(() => owner.resetEffect()),
    dispose: Effect.suspend(() => owner.disposeEffect()),
    snapshot: Effect.sync(() => owner.snapshot()),
  };
}

function automaticPromiseTaskEffect(
  task: JscpdAutomaticScanTask,
  context: JscpdAutomaticScanContext,
): Effect.Effect<JscpdAutomaticScanDisposition, unknown> {
  return Effect.tryPromise({
    try: () => task(context),
    catch: (error) => error,
  });
}

function closedExplicitResult<T>(): JscpdExplicitRunResult<T> {
  return Object.freeze({ status: "closed" });
}

/** Cancel scheduler-owned automatic work before explicit scan operations. */
export function createJscpdScheduledExecutor(
  executor: JscpdCommandExecutor,
  scheduler: JscpdScanScheduler,
): JscpdCommandExecutor {
  return {
    async execute(invocation, context) {
      if (invocation.command === "off") scheduler.cancelAutomatic();
      if (invocation.command !== "scan" && invocation.command !== "changed") {
        return executor.execute(invocation, context);
      }
      const scheduled = await scheduler.runExplicit(() => executor.execute(invocation, context));
      return scheduled.status === "completed" ? scheduled.value : schedulerClosedResult();
    },
  };
}

function schedulerClosedResult(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "scan-cancelled",
    message: "The jscpd scan was cancelled because the session is shutting down.",
  });
}
