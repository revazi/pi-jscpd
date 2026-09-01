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
  | { status: "no-findings" }
  | { status: "rejected"; reason: JscpdReportErrorCode };

export type JscpdUnavailableReason =
  | "not-implemented"
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

export interface JscpdCommandExecutor {
  execute(
    invocation: JscpdCommandInvocation,
    context: JscpdExecutionContext,
  ): Promise<JscpdUnavailableResult>;
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
  | JscpdUnavailableResult
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
