import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import {
  createJscpdAutomaticAcknowledgementView,
  createJscpdAutomaticCheck,
} from "../src/automatic.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";

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

function executor(result: JscpdExecutionResult = cleanResult) {
  const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => result);
  return { service: { execute } satisfies JscpdCommandExecutor, execute };
}

describe("automatic changed check", () => {
  it("reads explicit acknowledgements without mutating them during comparison", () => {
    const source = createJscpdAcknowledgementTracker();
    const finding = {
      fingerprint: "a".repeat(64),
      paths: ["src/a.ts", "src/b.ts"] as const,
    };
    source.reconcile(source.revision(), [finding], [finding]);
    const view = createJscpdAutomaticAcknowledgementView(source);

    expect(view.scope()).toBe(source.scope());
    expect(view.revision()).toBe(source.revision());
    expect(view.has(finding.fingerprint)).toBe(true);
    expect(view.findings()).toEqual([finding]);
    expect(view.reconcile(view.revision(), [], [])).toBe(false);
    expect(view.invalidatePaths(["src/a.ts"])).toBe(false);
    view.reset();
    expect(source.findings()).toEqual([finding]);
  });

  it("runs the bounded changed path and reports one terminal result to its internal sink", async () => {
    const changed = executor();
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck(changed.service, { onResult });
    const controller = new AbortController();

    await expect(check.run({ cwd: "/project", signal: controller.signal })).resolves.toBe(
      "attempted",
    );
    expect(changed.execute).toHaveBeenCalledWith(
      { command: "changed", args: [] },
      { cwd: "/project", signal: controller.signal },
    );
    expect(onResult).toHaveBeenCalledWith(cleanResult);
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
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => {
      throw new Error("private failure");
    });
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck({ execute }, { onResult });

    await expect(
      check.run({ cwd: "/project", signal: new AbortController().signal }),
    ).resolves.toBe("attempted");
    expect(onResult).toHaveBeenCalledWith({
      status: "failed",
      reason: "process-failed",
      message: "The automatic jscpd check failed safely; no result was used.",
    });
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
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => {
      controller.abort();
      return cleanResult;
    });
    const onResult = vi.fn();
    const check = createJscpdAutomaticCheck({ execute }, { onResult });

    await expect(check.run({ cwd: "/project", signal: controller.signal })).resolves.toBe(
      "deferred",
    );
    expect(onResult).not.toHaveBeenCalled();
  });
});
