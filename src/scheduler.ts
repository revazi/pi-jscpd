import type { JscpdCommandExecutor, JscpdExecutionResult } from "./types.js";

export interface JscpdAutomaticScanContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export type JscpdAutomaticScanDisposition = "attempted" | "deferred";

export type JscpdAutomaticScanTask = (
  context: JscpdAutomaticScanContext,
) => Promise<JscpdAutomaticScanDisposition>;

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
  /** Explicit work supersedes only scheduler-owned automatic work. */
  runExplicit<T>(task: () => Promise<T>): Promise<JscpdExplicitRunResult<T>>;
  /** Abort and discard pending automatic work without consuming its generation. */
  cancelAutomatic(): void;
  /** Start a fresh active-branch scope while keeping the scheduler reusable. */
  reset(): void;
  /** Prevent future work, abort automatic ownership, and await its settlement. */
  dispose(): Promise<void>;
  snapshot(): JscpdScanSchedulerSnapshot;
}

interface PendingAutomaticScan {
  readonly epoch: number;
  readonly generation: number;
  readonly task: JscpdAutomaticScanTask;
}

interface ActiveAutomaticScan extends PendingAutomaticScan {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

/**
 * Own only automatic scheduling and cancellation. Scan processes remain serialized by JscpdService.
 * The queue is bounded to one active and one latest-generation pending automatic request.
 */
export function createJscpdScanScheduler(): JscpdScanScheduler {
  let epoch = 0;
  let changedGeneration = 0;
  let attemptedGeneration = 0;
  let pending: PendingAutomaticScan | undefined;
  let active: ActiveAutomaticScan | undefined;
  let startQueued = false;
  let closed = false;
  let disposePromise: Promise<void> | undefined;

  const queueStart = () => {
    if (startQueued || closed || active || !pending) return;
    startQueued = true;
    queueMicrotask(() => {
      startQueued = false;
      startPending();
    });
  };

  const startPending = () => {
    if (closed || active || !pending) return;
    const candidate = pending;
    pending = undefined;
    if (
      candidate.epoch !== epoch ||
      candidate.generation <= attemptedGeneration ||
      candidate.generation > changedGeneration
    ) {
      queueStart();
      return;
    }

    const controller = new AbortController();
    const settled = Promise.resolve()
      .then(() =>
        candidate.task(
          Object.freeze({ generation: candidate.generation, signal: controller.signal }),
        ),
      )
      .then(
        (disposition) => finishAutomatic(candidate, controller, disposition),
        () => finishAutomatic(candidate, controller, "attempted"),
      );
    active = Object.freeze({ ...candidate, controller, settled });
  };

  const finishAutomatic = (
    candidate: PendingAutomaticScan,
    controller: AbortController,
    disposition: JscpdAutomaticScanDisposition,
  ): void => {
    if (active?.controller !== controller) return;
    active = undefined;
    if (
      disposition === "attempted" &&
      !closed &&
      candidate.epoch === epoch &&
      !controller.signal.aborted
    ) {
      attemptedGeneration = Math.max(attemptedGeneration, candidate.generation);
    }
    queueStart();
  };

  const cancelAutomatic = () => {
    epoch += 1;
    pending = undefined;
    active?.controller.abort();
  };

  const hasCurrentRequestFor = (generation: number): boolean =>
    (active?.epoch === epoch && active.generation >= generation) ||
    (pending?.epoch === epoch && pending.generation >= generation);

  return {
    markChanged() {
      if (closed) return changedGeneration;
      if (changedGeneration >= Number.MAX_SAFE_INTEGER) {
        cancelAutomatic();
        changedGeneration = 1;
        attemptedGeneration = 0;
      } else {
        changedGeneration += 1;
      }
      return changedGeneration;
    },
    requestAutomatic(task) {
      if (closed || changedGeneration <= attemptedGeneration) return false;
      const generation = changedGeneration;
      if (hasCurrentRequestFor(generation)) return false;
      pending = Object.freeze({ epoch, generation, task });
      queueStart();
      return true;
    },
    async runExplicit(task) {
      if (closed) return Object.freeze({ status: "closed" });
      cancelAutomatic();
      if (closed) return Object.freeze({ status: "closed" });
      return Object.freeze({ status: "completed" as const, value: await task() });
    },
    cancelAutomatic,
    reset() {
      if (closed) return;
      cancelAutomatic();
      changedGeneration = 0;
      attemptedGeneration = 0;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      closed = true;
      cancelAutomatic();
      const activeSettlement = active?.settled ?? Promise.resolve();
      disposePromise = activeSettlement.then(() => undefined);
      return disposePromise;
    },
    snapshot() {
      return Object.freeze({
        changedGeneration,
        attemptedGeneration,
        automatic: active ? "active" : pending ? "pending" : "idle",
        closed,
      });
    },
  };
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
