import type { JscpdCapabilityResult } from "./capability.js";
import type { JscpdCommand } from "./registry.js";

export type { JscpdCommand } from "./registry.js";

export interface JscpdCommandInvocation {
  command: JscpdCommand;
  args: readonly string[];
}

export interface JscpdExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

/** Reporter-independent statistics supplied by jscpd; pi-jscpd does not recalculate them. */
export interface JscpdStatisticsRow {
  readonly lines: number;
  readonly tokens: number;
  readonly sources: number;
  readonly clones: number;
  readonly duplicatedLines: number;
  readonly duplicatedTokens: number;
  readonly percentage: number;
  readonly percentageTokens: number;
  readonly newDuplicatedLines: number;
  readonly newClones: number;
}

export interface JscpdFormatStatistics extends JscpdStatisticsRow {
  readonly format: string;
}

export interface JscpdScanStatistics {
  readonly total: JscpdStatisticsRow;
  /** Sorted by format so reporter object-key order cannot affect normalized output. */
  readonly formats: readonly JscpdFormatStatistics[];
}

export interface JscpdSourceLocation {
  /** One-based source line. */
  readonly line: number;
  /** Zero-based source column, as emitted by jscpd v5. */
  readonly column: number;
  /** Zero-based source byte offset, named `position` by the JSON reporter. */
  readonly offset: number;
}

export interface JscpdCloneOccurrence {
  /** Canonical project-relative path using `/` separators. */
  readonly path: string;
  readonly start: JscpdSourceLocation;
  readonly end: JscpdSourceLocation;
}

/** The v5 JSON reporter models each clone as one pair rather than a larger clone group. */
export interface JscpdClonePair {
  readonly format: string;
  readonly lines: number;
  readonly tokens: number;
  readonly occurrences: readonly [JscpdCloneOccurrence, JscpdCloneOccurrence];
}

export interface JscpdScanReport {
  readonly statistics: JscpdScanStatistics;
  /** Deterministically sorted, bounded clone pairs with no source fragments. */
  readonly clonePairs: readonly JscpdClonePair[];
}

export type JscpdReportErrorCode =
  | "malformed-json"
  | "unsupported-reporter"
  | "invalid-top-level"
  | "invalid-duplicates"
  | "invalid-statistics"
  | "invalid-location"
  | "unsafe-path"
  | "limit-exceeded"
  | "duplicate-key"
  | "ambiguous-path"
  | "ambiguous-duplicate";

export type JscpdReportDecision<T> =
  | { status: "accepted"; value: T }
  | { status: "no-findings"; value?: T }
  | { status: "rejected"; reason: JscpdReportErrorCode };

export type JscpdUnavailableReason =
  | "disabled"
  | "missing-binary"
  | "incompatible-version"
  | "probe-cancelled"
  | "probe-timed-out"
  | "probe-failed";

export interface JscpdUnavailableResult {
  status: "unavailable";
  reason: JscpdUnavailableReason;
  message: string;
  capability?: JscpdCapabilityResult;
}

export interface JscpdScanSummary {
  readonly clones: number;
  readonly duplicatedLines: number;
  readonly duplicatedTokens: number;
  readonly lines: number;
  readonly tokens: number;
  readonly sources: number;
  readonly percentage: number;
  readonly percentageTokens: number;
}

export interface JscpdPresentedOccurrence {
  /** A bounded project-relative display path followed by exact line coordinates. */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface JscpdPresentedFinding {
  readonly format: string;
  readonly lines: number;
  readonly tokens: number;
  readonly occurrences: readonly [JscpdPresentedOccurrence, JscpdPresentedOccurrence];
}

export interface JscpdChangedOccurrence extends JscpdPresentedOccurrence {
  readonly relation: "new-session" | "existing-match";
}

export interface JscpdChangedFinding {
  readonly format: string;
  readonly lines: number;
  readonly tokens: number;
  readonly occurrences: readonly [JscpdChangedOccurrence, JscpdChangedOccurrence];
}

export interface JscpdChangedResult {
  readonly status: "changed";
  readonly outcome: "findings" | "clean";
  /** False only when the check short-circuited because no session-owned files were tracked. */
  readonly scanPerformed: boolean;
  readonly message: string;
  readonly terminalMessage: string;
  readonly findings: readonly JscpdChangedFinding[];
  readonly omittedFindings: number;
  readonly ambiguousFindings: number;
  readonly verification?: JscpdVerificationResult;
}

export type JscpdChangedUnavailableReason =
  | "baseline-pending"
  | "baseline-unavailable"
  | "baseline-partial"
  | "baseline-cancelled"
  | "baseline-timed-out"
  | "baseline-failed"
  | "identity-partial";

export interface JscpdChangedUnavailableResult {
  readonly status: "changed-unavailable";
  readonly reason: JscpdChangedUnavailableReason;
  readonly message: string;
}

export type JscpdVerificationResult =
  | {
      readonly state: "checkpoint";
      readonly scope: "changed" | "project";
      readonly groups: number;
      readonly message: string;
    }
  | {
      readonly state: "compared";
      readonly scope: "changed" | "project";
      readonly removed: number;
      readonly remaining: number;
      readonly created: number;
      readonly ambiguous: number;
      readonly message: string;
    }
  | {
      readonly state: "unavailable";
      readonly scope: "changed" | "project";
      readonly reason: "identity-partial" | "lifecycle-changed";
      readonly message: string;
    };

export interface JscpdCompletedResult {
  readonly status: "completed";
  readonly outcome: "findings" | "clean";
  /** Concise content returned to the model-facing tool. */
  readonly message: string;
  /** Concise content shown by the terminal slash command. */
  readonly terminalMessage: string;
  readonly summary: JscpdScanSummary;
  readonly findings: readonly JscpdPresentedFinding[];
  readonly omittedFindings: number;
  readonly verification?: JscpdVerificationResult;
}

export type JscpdScanFailureReason =
  | "unsafe-path"
  | "unsupported-path"
  | "scan-cancelled"
  | "scan-timed-out"
  | "process-failed"
  | "missing-report"
  | "malformed-report"
  | "incompatible-report"
  | "invalid-report"
  | "cleanup-failed";

export interface JscpdScanFailureResult {
  readonly status: "failed";
  readonly reason: JscpdScanFailureReason;
  readonly message: string;
}

export type JscpdLastCheck =
  | { readonly state: "never" }
  | { readonly state: "clean" }
  | { readonly state: "findings"; readonly clones: number }
  | { readonly state: "cancelled" }
  | {
      readonly state: "failed";
      readonly reason: JscpdScanFailureReason | JscpdUnavailableReason;
    };

export interface JscpdStatusResult {
  readonly status: "status";
  readonly message: string;
  readonly terminalMessage: string;
  readonly mode: "enabled" | "disabled";
  readonly modeSource: "configuration" | "session";
  readonly configSource: "defaults" | "project" | "local";
  readonly configSources: readonly ("defaults" | "project" | "local")[];
  readonly configDiagnostics: number;
  readonly capability: JscpdCapabilityResult;
  readonly lastCheck: JscpdLastCheck;
  readonly fallowOverlap?:
    | "absent"
    | "detected"
    | "ambiguous"
    | "explicit-allow"
    | "explicit-on-demand";
  readonly fallowAutomatic?: "allowed" | "on-demand";
}

export interface JscpdControlResult {
  readonly status: "control";
  readonly action: "enabled" | "disabled";
  readonly message: string;
  readonly terminalMessage: string;
}

export interface JscpdHelpResult {
  readonly status: "help";
  readonly message: string;
  readonly terminalMessage: string;
}

export type JscpdExecutionResult =
  | JscpdCompletedResult
  | JscpdUnavailableResult
  | JscpdScanFailureResult
  | JscpdStatusResult
  | JscpdControlResult
  | JscpdHelpResult
  | JscpdChangedResult
  | JscpdChangedUnavailableResult;

export interface JscpdCommandExecutor {
  execute(
    invocation: JscpdCommandInvocation,
    context: JscpdExecutionContext,
  ): Promise<JscpdExecutionResult>;
}

export type JscpdInputErrorCode =
  | "invalid-command"
  | "unsupported-command"
  | "invalid-arguments"
  | "input-too-long"
  | "too-many-arguments"
  | "argument-too-long"
  | "unclosed-quote";

export interface JscpdInputError {
  code: JscpdInputErrorCode;
  message: string;
}

export type JscpdParseResult =
  | { ok: true; invocation: JscpdCommandInvocation }
  | { ok: false; error: JscpdInputError };

export type JscpdSlashParseResult =
  | { ok: true; kind: "bare" }
  | { ok: true; kind: "command"; invocation: JscpdCommandInvocation }
  | { ok: false; error: JscpdInputError };

export type JscpdDispatchResult =
  | JscpdExecutionResult
  | {
      status: "invalid";
      reason: JscpdInputErrorCode;
      message: string;
    }
  | {
      status: "error";
      reason: "execution-failed";
      message: string;
    };
