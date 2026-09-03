import type { JscpdAcknowledgementTracker } from "./acknowledgements.js";
import type { JscpdAutomaticScanDisposition } from "./scheduler.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "./types.js";

export interface JscpdAutomaticCheckContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface JscpdAutomaticCheck {
  run(context: JscpdAutomaticCheckContext): Promise<JscpdAutomaticScanDisposition>;
}

export interface JscpdAutomaticCheckOptions {
  /** Internal result sink for later status/presentation wiring. */
  readonly onResult?: (
    result: JscpdExecutionResult,
  ) =>
    | JscpdAutomaticScanDisposition
    | undefined
    | Promise<JscpdAutomaticScanDisposition | undefined>;
}

/** Give automatic comparison current acknowledgement reads without allowing acknowledgement writes. */
export function createJscpdAutomaticAcknowledgementView(
  source: JscpdAcknowledgementTracker,
): JscpdAcknowledgementTracker {
  return Object.freeze({
    restore: () => undefined,
    reset: () => undefined,
    scope: () => source.scope(),
    revision: () => source.revision(),
    findings: () => source.findings(),
    has: (fingerprint: string) => source.has(fingerprint),
    invalidatePaths: () => false,
    reconcile: () => false,
  });
}

/** Execute one fail-open changed check without injecting anything into Pi context. */
export function createJscpdAutomaticCheck(
  executor: JscpdCommandExecutor,
  options: JscpdAutomaticCheckOptions = {},
): JscpdAutomaticCheck {
  return {
    async run(context) {
      let result: JscpdExecutionResult;
      try {
        result = await executor.execute(
          { command: "changed", args: [] },
          { cwd: context.cwd, signal: context.signal },
        );
      } catch {
        result = automaticFailure();
      }

      const disposition = automaticDisposition(result, context.signal);
      if (disposition === "deferred") return disposition;
      try {
        const handled = await options.onResult?.(result);
        if (handled === "deferred") return "deferred";
      } catch {
        return "deferred";
      }
      return context.signal.aborted ? "deferred" : "attempted";
    },
  };
}

function automaticDisposition(
  result: JscpdExecutionResult,
  signal: AbortSignal,
): JscpdAutomaticScanDisposition {
  if (signal.aborted) return "deferred";
  if (result.status === "changed-unavailable" && result.reason === "baseline-pending") {
    return "deferred";
  }
  if (result.status === "failed" && result.reason === "scan-cancelled") return "deferred";
  if (result.status === "unavailable" && result.reason === "probe-cancelled") return "deferred";
  return "attempted";
}

function automaticFailure(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "process-failed",
    message: "The automatic jscpd check failed safely; no result was used.",
  });
}
