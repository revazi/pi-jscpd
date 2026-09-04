import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import {
  boundedJscpdAutomaticFindingLimit,
  compactJscpdAutomaticStatus,
  createJscpdAutomaticAcknowledgementTransaction,
  type JscpdAutomaticResultActions,
} from "../src/automatic.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";
import {
  createAutomaticCheckTestDriver as createJscpdAutomaticCheck,
  handleAutomaticResultForTest as handleJscpdAutomaticResult,
} from "./support/automatic.js";
import { commandFromPromise, type TestCommandExecute } from "./support/command.js";

const cleanResult = {
  status: "changed",
  outcome: "clean",
  scanPerformed: true,
  message: "clean",
  terminalMessage: "clean",
  findings: [],
  omittedFindings: 0,
  ambiguousFindings: 0,
} as const;

const findingsResult = {
  status: "changed",
  outcome: "findings",
  scanPerformed: true,
  message:
    "jscpd changed found 1 unacknowledged new duplicate block.\n1. new in this session: src/a.ts:1-4 ↔ existing match: src/b.ts:8-11.\nInspect both before deciding whether to refactor.",
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
  omittedFindings: 2,
  ambiguousFindings: 1,
} as const satisfies JscpdExecutionResult;

function executor(result: JscpdExecutionResult = cleanResult) {
  const execute = vi.fn<TestCommandExecute>(async () => result);
  return { service: commandFromPromise(execute) satisfies JscpdCommandExecutor, execute };
}

function delivery(
  overrides: Partial<JscpdAutomaticResultActions> = {},
): JscpdAutomaticResultActions {
  const acknowledgements = createJscpdAutomaticAcknowledgementTransaction(
    createJscpdAcknowledgementTracker(),
  );
  return {
    isCurrent: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    acknowledgements,
    sendFinding: vi.fn(),
    record: vi.fn(),
    persist: vi.fn(),
    setStatus: vi.fn(),
    ...overrides,
  };
}

function stagedFinding() {
  return {
    fingerprint: "a".repeat(64),
    paths: ["src/a.ts", "src/b.ts"] as const,
  };
}

describe("automatic changed check", () => {
  it("applies a stricter five-finding automatic context cap", () => {
    expect(boundedJscpdAutomaticFindingLimit(1)).toBe(1);
    expect(boundedJscpdAutomaticFindingLimit(5)).toBe(5);
    expect(boundedJscpdAutomaticFindingLimit(100)).toBe(5);
    expect(boundedJscpdAutomaticFindingLimit(Number.NaN)).toBe(5);
  });

  it("stages acknowledgement writes while retaining current acknowledgement reads", () => {
    const source = createJscpdAcknowledgementTracker();
    const existing = stagedFinding();
    source.reconcile(source.revision(), [existing], [existing]);
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);

    expect(transaction.tracker.scope()).toBe(source.scope());
    expect(transaction.tracker.revision()).toBe(source.revision());
    expect(transaction.tracker.has(existing.fingerprint)).toBe(true);
    expect(transaction.tracker.findings()).toEqual([existing]);
    expect(transaction.tracker.reconcile(transaction.tracker.revision(), [existing], [])).toBe(
      false,
    );
    expect(source.findings()).toEqual([existing]);
    expect(transaction.ready()).toBe(true);
    expect(transaction.commit()).toBe(true);
    expect(source.findings()).toEqual([existing]);
  });

  it("rejects a staged acknowledgement after its source revision changes", () => {
    const source = createJscpdAcknowledgementTracker();
    const staged = stagedFinding();
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);
    transaction.tracker.reconcile(source.revision(), [staged], [staged]);

    source.invalidatePaths(["src/a.ts"]);
    source.reconcile(source.revision(), [], []);

    expect(transaction.ready()).toBe(false);
    expect(transaction.commit()).toBe(false);
    expect(source.findings()).toEqual([]);
  });

  it("runs the bounded changed path and reports one terminal result to its sink", async () => {
    const changed = executor();
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck(changed.service, { onResult });
    const controller = new AbortController();
    const context = { cwd: "/project", signal: controller.signal };

    await expect(check.run(context)).resolves.toBe("attempted");
    expect(changed.execute).toHaveBeenCalledWith(
      { command: "changed", args: [] },
      { cwd: "/project", signal: controller.signal },
    );
    expect(onResult).toHaveBeenCalledWith(cleanResult, context);
  });

  it("uses a lifecycle-bound result sink and rejects a stale completion", async () => {
    const changed = executor();
    const fallback = vi.fn();
    const current = vi.fn(() => true);
    const runSink = vi.fn();
    const check = createJscpdAutomaticCheck(changed.service, { onResult: fallback });

    await expect(
      check.run({
        cwd: "/project",
        signal: new AbortController().signal,
        isCurrent: current,
        onResult: runSink,
      }),
    ).resolves.toBe("attempted");
    expect(runSink).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();

    current.mockReturnValue(false);
    runSink.mockClear();
    await expect(
      check.run({
        cwd: "/project",
        signal: new AbortController().signal,
        isCurrent: current,
        onResult: runSink,
      }),
    ).resolves.toBe("deferred");
    expect(runSink).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        status: "changed-unavailable",
        reason: "baseline-pending",
        message: "pending",
      } as const,
    ],
    [
      {
        status: "failed",
        reason: "scan-cancelled",
        message: "cancelled",
      } as const,
    ],
    [
      {
        status: "unavailable",
        reason: "probe-cancelled",
        message: "cancelled",
      } as const,
    ],
  ])("leaves retryable outcome %# out of result handling", async (result) => {
    const changed = executor(result);
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck(changed.service, { onResult });

    await expect(
      check.run({ cwd: "/project", signal: new AbortController().signal }),
    ).resolves.toBe("deferred");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("normalizes unexpected executor errors as a quiet terminal failure", async () => {
    const execute = vi.fn<TestCommandExecute>(async () => {
      throw new Error("private failure");
    });
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck(commandFromPromise(execute), { onResult });

    await expect(
      check.run({ cwd: "/project", signal: new AbortController().signal }),
    ).resolves.toBe("attempted");
    expect(onResult).toHaveBeenCalledWith(
      {
        status: "failed",
        reason: "process-failed",
        message: "The automatic jscpd check failed safely; no result was used.",
      },
      expect.any(Object),
    );
  });

  it("keeps the generation retryable when result handling cannot complete", async () => {
    const changed = executor();
    const deferredSink = createJscpdAutomaticCheck(changed.service, {
      onResult: () => "deferred",
    });
    await expect(
      deferredSink.run({ cwd: "/project", signal: new AbortController().signal }),
    ).resolves.toBe("deferred");

    const failedSink = createJscpdAutomaticCheck(changed.service, {
      onResult: () => {
        throw new Error("sink failed");
      },
    });
    await expect(
      failedSink.run({ cwd: "/project", signal: new AbortController().signal }),
    ).resolves.toBe("deferred");
  });

  it("discards a result when lifecycle cancellation wins during execution", async () => {
    const controller = new AbortController();
    const execute = vi.fn<TestCommandExecute>(async () => {
      controller.abort();
      return cleanResult;
    });
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck(commandFromPromise(execute), { onResult });

    await expect(check.run({ cwd: "/project", signal: controller.signal })).resolves.toBe(
      "deferred",
    );
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("automatic result delivery", () => {
  it("records clean state and compact UI status without injecting a message", () => {
    const actions = delivery();
    actions.acknowledgements.tracker.reconcile(actions.acknowledgements.tracker.revision(), [], []);

    expect(handleJscpdAutomaticResult(cleanResult, actions)).toBe("attempted");
    expect(actions.sendFinding).not.toHaveBeenCalled();
    expect(actions.record).toHaveBeenCalledWith(cleanResult);
    expect(actions.persist).toHaveBeenCalledOnce();
    expect(actions.setStatus).toHaveBeenCalledWith("jscpd: clean");
  });

  it("delivers one bounded finding message before committing its acknowledgement", () => {
    const source = createJscpdAcknowledgementTracker();
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);
    const finding = stagedFinding();
    transaction.tracker.reconcile(source.revision(), [finding], [finding]);
    const order: string[] = [];
    const actions = delivery({
      acknowledgements: transaction,
      sendFinding: vi.fn(() => order.push("message")),
      persist: vi.fn(() => order.push("persist")),
    });

    expect(handleJscpdAutomaticResult(findingsResult, actions)).toBe("attempted");
    expect(actions.sendFinding).toHaveBeenCalledWith(findingsResult.message, {
      source: "automatic",
      findings: 1,
      omittedFindings: 2,
      ambiguousFindings: 1,
    });
    expect(source.findings()).toEqual([finding]);
    expect(order).toEqual(["message", "persist"]);
    expect(actions.record).toHaveBeenCalledWith(findingsResult);
    expect(actions.setStatus).toHaveBeenCalledWith("jscpd: 3 new duplicate blocks");
  });

  it("does not acknowledge or record a finding when durable delivery fails", () => {
    const source = createJscpdAcknowledgementTracker();
    const transaction = createJscpdAutomaticAcknowledgementTransaction(source);
    const finding = stagedFinding();
    transaction.tracker.reconcile(source.revision(), [finding], [finding]);
    const actions = delivery({
      acknowledgements: transaction,
      sendFinding: vi.fn(() => {
        throw new Error("session unavailable");
      }),
    });

    expect(handleJscpdAutomaticResult(findingsResult, actions)).toBe("deferred");
    expect(source.findings()).toEqual([]);
    expect(actions.record).not.toHaveBeenCalled();
    expect(actions.persist).not.toHaveBeenCalled();
    expect(actions.setStatus).not.toHaveBeenCalled();
  });

  it.each([
    { isCurrent: () => false },
    { isIdle: () => false },
    { hasPendingMessages: () => true },
  ])("defers stale or busy delivery without side effects: %j", (override) => {
    const actions = delivery(override);

    expect(handleJscpdAutomaticResult(findingsResult, actions)).toBe("deferred");
    expect(actions.sendFinding).not.toHaveBeenCalled();
    expect(actions.record).not.toHaveBeenCalled();
    expect(actions.persist).not.toHaveBeenCalled();
    expect(actions.setStatus).not.toHaveBeenCalled();
  });

  it("keeps terminal failures out of model context while updating status", () => {
    const actions = delivery();
    const failure = {
      status: "failed",
      reason: "scan-timed-out",
      message: "timed out",
    } as const;

    expect(handleJscpdAutomaticResult(failure, actions)).toBe("attempted");
    expect(actions.sendFinding).not.toHaveBeenCalled();
    expect(actions.record).toHaveBeenCalledWith(failure);
    expect(actions.persist).toHaveBeenCalledOnce();
    expect(actions.setStatus).toHaveBeenCalledWith("jscpd: check timed out");
  });

  it("produces bounded labels only for automatic check outcomes", () => {
    expect(compactJscpdAutomaticStatus(cleanResult)).toBe("jscpd: clean");
    expect(compactJscpdAutomaticStatus(findingsResult)).toBe("jscpd: 3 new duplicate blocks");
    expect(
      compactJscpdAutomaticStatus({
        status: "unavailable",
        reason: "disabled",
        message: "disabled",
      }),
    ).toBe("jscpd: disabled");
    expect(
      compactJscpdAutomaticStatus({
        ...cleanResult,
        scanPerformed: false,
      }),
    ).toBeUndefined();
  });
});
