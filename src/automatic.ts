import type { JscpdAcknowledgedFinding, JscpdAcknowledgementTracker } from "./acknowledgements.js";
import type { JscpdAutomaticScanDisposition } from "./scheduler.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "./types.js";

export const JSCPD_AUTOMATIC_MESSAGE_TYPE = "pi-jscpd/automatic-findings";
export const JSCPD_AUTOMATIC_STATUS_KEY = "pi-jscpd";
const MAX_AUTOMATIC_FINDINGS = 5;

export function boundedJscpdAutomaticFindingLimit(configuredLimit: number): number {
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) return MAX_AUTOMATIC_FINDINGS;
  return Math.min(configuredLimit, MAX_AUTOMATIC_FINDINGS);
}

export interface JscpdAutomaticCheckContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Reject result side effects after a mutation or lifecycle transition supersedes this run. */
  readonly isCurrent?: () => boolean;
  readonly onResult?: JscpdAutomaticResultHandler;
}

export type JscpdAutomaticResultHandler = (
  result: JscpdExecutionResult,
  context: JscpdAutomaticCheckContext,
) => JscpdAutomaticScanDisposition | undefined | Promise<JscpdAutomaticScanDisposition | undefined>;

export interface JscpdAutomaticCheck {
  run(context: JscpdAutomaticCheckContext): Promise<JscpdAutomaticScanDisposition>;
}

export interface JscpdAutomaticCheckOptions {
  /** Internal result sink used when a run does not supply its lifecycle-bound sink. */
  readonly onResult?: JscpdAutomaticResultHandler;
  readonly beforeRun?: () => void;
}

export interface JscpdAutomaticFindingDetails {
  readonly source: "automatic";
  readonly findings: number;
  readonly omittedFindings: number;
  readonly ambiguousFindings: number;
}

export interface JscpdAutomaticResultActions {
  readonly isCurrent: () => boolean;
  readonly isIdle: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly acknowledgements: JscpdAutomaticAcknowledgementTransaction;
  readonly sendFinding: (content: string, details: JscpdAutomaticFindingDetails) => void;
  readonly record: (result: JscpdExecutionResult) => void;
  readonly persist: () => void;
  readonly setStatus?: (text: string) => void;
}

export interface JscpdAutomaticAcknowledgementTransaction {
  readonly tracker: JscpdAcknowledgementTracker;
  discard(): void;
  ready(): boolean;
  commit(): boolean;
}

interface StagedAcknowledgements {
  readonly expectedRevision: number;
  readonly active: readonly JscpdAcknowledgedFinding[];
  readonly surfaced: readonly JscpdAcknowledgedFinding[];
}

/** Stage automatic acknowledgement changes until finding delivery succeeds. */
export function createJscpdAutomaticAcknowledgementTransaction(
  source: JscpdAcknowledgementTracker,
): JscpdAutomaticAcknowledgementTransaction {
  let staged: StagedAcknowledgements | undefined;
  const tracker: JscpdAcknowledgementTracker = {
    restore: () => undefined,
    reset: () => undefined,
    scope: () => source.scope(),
    revision: () => source.revision(),
    findings: () => source.findings(),
    has: (fingerprint) => source.has(fingerprint),
    invalidatePaths: () => false,
    reconcile(expectedRevision, active, surfaced) {
      staged = Object.freeze({
        expectedRevision,
        active: Object.freeze([...active]),
        surfaced: Object.freeze([...surfaced]),
      });
      return false;
    },
  };
  return Object.freeze({
    tracker: Object.freeze(tracker),
    discard() {
      staged = undefined;
    },
    ready: () => !!staged && source.revision() === staged.expectedRevision,
    commit() {
      const pending = staged;
      staged = undefined;
      return pending
        ? source.reconcile(pending.expectedRevision, pending.active, pending.surfaced)
        : false;
    },
  });
}

/** Deliver only current actionable findings; clean and failed checks remain outside model context. */
export function handleJscpdAutomaticResult(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticResultActions,
): JscpdAutomaticScanDisposition {
  if (!actions.isCurrent() || !actions.isIdle() || actions.hasPendingMessages()) return "deferred";
  if (isScannedChangedResult(result) && !actions.acknowledgements.ready()) return "deferred";

  if (isActionableChangedResult(result)) {
    try {
      actions.sendFinding(result.message, {
        source: "automatic",
        findings: result.findings.length,
        omittedFindings: result.omittedFindings,
        ambiguousFindings: result.ambiguousFindings,
      });
    } catch {
      return "deferred";
    }
    actions.acknowledgements.commit();
  } else if (isScannedChangedResult(result)) {
    actions.acknowledgements.commit();
  } else {
    actions.acknowledgements.discard();
  }

  try {
    actions.record(result);
    actions.persist();
  } catch {
    // Automatic status persistence is advisory after any finding message was delivered.
  }
  const status = compactJscpdAutomaticStatus(result);
  if (status) {
    try {
      actions.setStatus?.(status);
    } catch {
      // UI status must never affect automatic scan disposition.
    }
  }
  return "attempted";
}

export function compactJscpdAutomaticStatus(result: JscpdExecutionResult): string | undefined {
  if (result.status === "changed") {
    if (!result.scanPerformed) return undefined;
    const count = result.findings.length + result.omittedFindings;
    return result.outcome === "clean"
      ? "jscpd: clean"
      : `jscpd: ${count} new duplicate block${count === 1 ? "" : "s"}`;
  }
  if (result.status === "changed-unavailable") return "jscpd: check unavailable";
  if (result.status === "unavailable") {
    return result.reason === "disabled" ? "jscpd: disabled" : "jscpd: check unavailable";
  }
  if (result.status === "failed") {
    return result.reason === "scan-timed-out" ? "jscpd: check timed out" : "jscpd: check failed";
  }
  return undefined;
}

/** Execute one fail-open changed check without directly injecting anything into Pi context. */
export function createJscpdAutomaticCheck(
  executor: JscpdCommandExecutor,
  options: JscpdAutomaticCheckOptions = {},
): JscpdAutomaticCheck {
  return {
    async run(context) {
      options.beforeRun?.();
      let result: JscpdExecutionResult;
      try {
        result = await executor.execute(
          { command: "changed", args: [] },
          { cwd: context.cwd, signal: context.signal },
        );
      } catch {
        result = automaticFailure();
      }

      const disposition = automaticDisposition(result, context);
      if (disposition === "deferred") return disposition;
      try {
        const handled = await (context.onResult ?? options.onResult)?.(result, context);
        if (handled === "deferred") return "deferred";
      } catch {
        return "deferred";
      }
      return isCurrent(context) ? "attempted" : "deferred";
    },
  };
}

function isScannedChangedResult(
  result: JscpdExecutionResult,
): result is Extract<JscpdExecutionResult, { status: "changed" }> {
  return result.status === "changed" && result.scanPerformed;
}

function isActionableChangedResult(
  result: JscpdExecutionResult,
): result is Extract<JscpdExecutionResult, { status: "changed" }> {
  return result.status === "changed" && result.outcome === "findings" && result.findings.length > 0;
}

function automaticDisposition(
  result: JscpdExecutionResult,
  context: JscpdAutomaticCheckContext,
): JscpdAutomaticScanDisposition {
  if (!isCurrent(context)) return "deferred";
  if (result.status === "changed-unavailable" && result.reason === "baseline-pending") {
    return "deferred";
  }
  if (result.status === "failed" && result.reason === "scan-cancelled") return "deferred";
  if (result.status === "unavailable" && result.reason === "probe-cancelled") return "deferred";
  return "attempted";
}

function isCurrent(context: JscpdAutomaticCheckContext): boolean {
  return !context.signal.aborted && (context.isCurrent?.() ?? true);
}

function automaticFailure(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "process-failed",
    message: "The automatic jscpd check failed safely; no result was used.",
  });
}
