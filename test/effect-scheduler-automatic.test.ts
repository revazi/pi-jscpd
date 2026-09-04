import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import {
  createJscpdAutomaticAcknowledgementTransaction,
  createJscpdAutomaticCheckLayer,
  handleJscpdAutomaticPiResultEffect,
  JscpdAutomaticChecking,
} from "../src/automatic.js";
import { JscpdTestEffectRuntime } from "../src/effect/runtime-boundary.js";
import {
  createJscpdScanSchedulerLayer,
  type JscpdAutomaticScanContext,
  JscpdScanScheduling,
} from "../src/scheduler.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";
import { createJscpdClockTestLayer, createJscpdPiPortTestLayer } from "./support/effect-layers.js";

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
  it("runs the changed check through the Effect service layer", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => cleanResult);
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
      program.pipe(Effect.provide(createJscpdAutomaticCheckLayer({ execute }))),
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
