import { Deferred, Effect, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import {
  createJscpdAutomaticAcknowledgementTransaction,
  createJscpdAutomaticCheckLayer,
  handleJscpdAutomaticPiResultEffect,
  JscpdAutomaticChecking,
} from "../src/automatic.js";
import {
  createJscpdScanScheduler,
  createJscpdScanSchedulerLayer,
  type JscpdAutomaticScanContext,
  JscpdScanScheduling,
} from "../src/scheduler.js";
import type { JscpdExecutionResult } from "../src/types.js";
import { commandFromPromise, type TestCommandExecute } from "./support/command.js";
import { createJscpdClockTestLayer, createJscpdPiPortTestLayer } from "./support/effect-layers.js";
import { JscpdTestEffectRuntime } from "./support/runtime.js";

const cleanResult = {
  status: "changed",
  outcome: "clean",
  scanPerformed: true,
  message: "clean",
  terminalMessage: "clean",
  findings: [],
  omittedFindings: 0,
  ambiguousFindings: 0,
} as const satisfies JscpdExecutionResult;

const findingsResult = {
  status: "changed",
  outcome: "findings",
  scanPerformed: true,
  message: "one bounded automatic finding",
  terminalMessage: "finding",
  findings: [
    {
      format: "typescript",
      lines: 4,
      tokens: 20,
      occurrences: [
        { path: "src/a.ts", startLine: 1, endLine: 4, relation: "new-session" },
        { path: "src/b.ts", startLine: 8, endLine: 11, relation: "existing-match" },
      ],
    },
  ],
  omittedFindings: 0,
  ambiguousFindings: 0,
} as const satisfies JscpdExecutionResult;

function finding() {
  return {
    fingerprint: "a".repeat(64),
    paths: ["src/a.ts", "src/b.ts"] as const,
  };
}

describe("Effect scan scheduling", () => {
  it("awaits native scheduler finalization and tolerates repeated disposal", async () => {
    let finalized = 0;
    let signal: AbortSignal | undefined;
    await JscpdTestEffectRuntime.runPromise(
      Effect.gen(function* () {
        const scheduler = createJscpdScanScheduler(yield* Scope.make());
        const started = yield* Deferred.make<void>();
        yield* scheduler.markChangedEffect;
        yield* scheduler.scheduleAutomaticEffect((context) =>
          Effect.sync(() => {
            signal = context.signal;
          }).pipe(
            Effect.zipRight(Deferred.succeed(started, undefined)),
            Effect.zipRight(Effect.never),
            Effect.ensuring(
              Effect.yieldNow().pipe(
                Effect.zipRight(
                  Effect.sync(() => {
                    finalized += 1;
                  }),
                ),
              ),
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* scheduler.disposeEffect;
        expect(finalized).toBe(1);
        expect(signal?.aborted).toBe(true);
        yield* scheduler.disposeEffect;
        expect(finalized).toBe(1);
        expect(yield* scheduler.snapshotEffect).toMatchObject({ closed: true, automatic: "idle" });
      }),
    );
  });

  it("settles a throwing native task and permits the next generation", async () => {
    const clock = createJscpdClockTestLayer();
    const task = vi.fn((): Effect.Effect<"attempted"> => {
      throw new Error("task construction failed");
    });
    const program = Effect.gen(function* () {
      const scheduler = yield* JscpdScanScheduling;
      yield* scheduler.markChanged;
      yield* scheduler.requestAutomatic(task);
      const awaitAttempt = (generation: number) =>
        scheduler.snapshot.pipe(
          Effect.tap(() => Effect.yieldNow()),
          Effect.repeat({
            until: (state) => state.automatic === "idle" && state.attemptedGeneration >= generation,
          }),
          Effect.timeout("1 second"),
        );
      yield* awaitAttempt(1);
      expect(task).toHaveBeenCalledOnce();
      expect(yield* scheduler.snapshot).toMatchObject({
        automatic: "idle",
        attemptedGeneration: 1,
      });
      yield* scheduler.markChanged;
      yield* scheduler.requestAutomatic(() => Effect.succeed("attempted"));
      yield* awaitAttempt(2);
      expect(yield* scheduler.snapshot).toMatchObject({
        automatic: "idle",
        attemptedGeneration: 2,
      });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(createJscpdScanSchedulerLayer(clock.layer))),
    );
  });

  it("uses the injected Effect clock for the coalescing boundary", async () => {
    const clock = createJscpdClockTestLayer();
    const program = Effect.gen(function* () {
      const scheduler = yield* JscpdScanScheduling;
      yield* scheduler.markChanged;
      yield* scheduler.requestAutomatic(() => Effect.succeed("attempted"));
      yield* Effect.yieldNow();
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(createJscpdScanSchedulerLayer(clock.layer))),
    );

    expect(clock.sleeps).toEqual([0]);
  });

  it("coalesces the pending request to the latest dirty generation", async () => {
    const contexts: JscpdAutomaticScanContext[] = [];
    const program = Effect.gen(function* () {
      const scheduler = yield* JscpdScanScheduling;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = vi.fn(() => Effect.succeed("attempted" as const));
      const second = vi.fn((context: JscpdAutomaticScanContext) =>
        Effect.gen(function* () {
          contexts.push(context);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return "attempted" as const;
        }),
      );

      yield* scheduler.markChanged;
      expect(yield* scheduler.requestAutomatic(first)).toBe(true);
      yield* scheduler.markChanged;
      expect(yield* scheduler.requestAutomatic(second)).toBe(true);
      yield* Deferred.await(started);
      expect(first).not.toHaveBeenCalled();
      expect(contexts[0]?.generation).toBe(2);
      expect(contexts[0]?.isCurrent()).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow();
    });

    await Effect.runPromise(program.pipe(Effect.provide(createJscpdScanSchedulerLayer())));
  });

  it("interrupts scoped automatic work and aborts its compatibility signal on release", async () => {
    let signal: AbortSignal | undefined;
    const program = Effect.gen(function* () {
      const scheduler = yield* JscpdScanScheduling;
      const started = yield* Deferred.make<void>();
      yield* scheduler.markChanged;
      yield* scheduler.requestAutomatic((context) =>
        Effect.gen(function* () {
          signal = context.signal;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      yield* Deferred.await(started);
      expect(signal?.aborted).toBe(false);
    });

    await Effect.runPromise(program.pipe(Effect.provide(createJscpdScanSchedulerLayer())));

    expect(signal?.aborted).toBe(true);
  });

  it("leaves an interrupted generation retryable", async () => {
    const program = Effect.gen(function* () {
      const scheduler = yield* JscpdScanScheduling;
      const started = yield* Deferred.make<void>();
      yield* scheduler.markChanged;
      yield* scheduler.requestAutomatic(() =>
        Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
      );
      yield* Deferred.await(started);
      yield* scheduler.cancelAutomatic;
      yield* Effect.yieldNow();
      const snapshot = yield* scheduler.snapshot;
      expect(snapshot.attemptedGeneration).toBe(0);
      expect(yield* scheduler.requestAutomatic(() => Effect.succeed("attempted"))).toBe(true);
    });

    await Effect.runPromise(program.pipe(Effect.provide(createJscpdScanSchedulerLayer())));
  });
});

describe("Effect automatic checking and delivery", () => {
  it("leaves a result retryable when its native handler throws during construction", async () => {
    const program = Effect.flatMap(JscpdAutomaticChecking, (automatic) =>
      automatic.run({
        cwd: "/project",
        signal: new AbortController().signal,
        onResult: (): Effect.Effect<"deferred"> => {
          throw new Error("handler construction failure");
        },
      }),
    ).pipe(
      Effect.provide(
        createJscpdAutomaticCheckLayer({
          executeEffect: () => Effect.succeed(cleanResult),
        }),
      ),
    );
    await expect(JscpdTestEffectRuntime.runPromise(program)).resolves.toBe("deferred");
  });

  it("runs the changed check through the Effect service layer", async () => {
    const execute = vi.fn<TestCommandExecute>(async () => cleanResult);
    const handled: JscpdExecutionResult[] = [];
    const program = Effect.flatMap(JscpdAutomaticChecking, (automatic) =>
      automatic.run({
        cwd: "/project",
        signal: new AbortController().signal,
        onResult: (result) =>
          Effect.sync(() => {
            handled.push(result);
            return "attempted" as const;
          }),
      }),
    );

    const disposition = await JscpdTestEffectRuntime.runPromise(
      program.pipe(Effect.provide(createJscpdAutomaticCheckLayer(commandFromPromise(execute)))),
    );

    expect(disposition).toBe("attempted");
    expect(execute).toHaveBeenCalledOnce();
    expect(handled).toEqual([cleanResult]);
  });

  it("delivers with triggerTurn false before committing acknowledgements", async () => {
    const source = createJscpdAcknowledgementTracker();
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);
    const staged = finding();
    transaction.tracker.reconcile(source.revision(), [staged], [staged]);
    const pi = createJscpdPiPortTestLayer();
    const recorded: JscpdExecutionResult[] = [];

    const disposition = await Effect.runPromise(
      handleJscpdAutomaticPiResultEffect(findingsResult, {
        isCurrent: Effect.succeed(true),
        isIdle: Effect.succeed(true),
        hasPendingMessages: Effect.succeed(false),
        acknowledgements: transaction.effects,
        record: (result) => Effect.sync(() => recorded.push(result)),
        persist: Effect.void,
        hasUI: true,
      }).pipe(Effect.provide(pi.layer)),
    );

    expect(disposition).toBe("attempted");
    expect(pi.messages).toEqual([
      {
        message: {
          customType: "pi-jscpd/automatic-findings",
          content: findingsResult.message,
          display: true,
          details: {
            source: "automatic",
            findings: 1,
            omittedFindings: 0,
            ambiguousFindings: 0,
          },
        },
        triggerTurn: false,
      },
    ]);
    expect(source.findings()).toEqual([staged]);
    expect(recorded).toEqual([findingsResult]);
    expect(pi.statuses).toEqual([{ key: "pi-jscpd", text: "jscpd: 1 new duplicate block" }]);
  });

  it("defers acknowledgement when typed Pi delivery fails", async () => {
    const source = createJscpdAcknowledgementTracker();
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);
    const staged = finding();
    transaction.tracker.reconcile(source.revision(), [staged], [staged]);
    const pi = createJscpdPiPortTestLayer();
    pi.failNext("delivery");

    const disposition = await Effect.runPromise(
      handleJscpdAutomaticPiResultEffect(findingsResult, {
        isCurrent: Effect.succeed(true),
        isIdle: Effect.succeed(true),
        hasPendingMessages: Effect.succeed(false),
        acknowledgements: transaction.effects,
        record: () => Effect.void,
        persist: Effect.void,
        hasUI: true,
      }).pipe(Effect.provide(pi.layer)),
    );

    expect(disposition).toBe("deferred");
    expect(source.findings()).toEqual([]);
    expect(pi.messages).toEqual([]);
    expect(pi.statuses).toEqual([]);
  });
});
