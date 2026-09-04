import { Data } from "effect";
import type {
  JscpdChangedUnavailableReason,
  JscpdScanFailureReason,
  JscpdUnavailableReason,
} from "../types.js";

/** Stable tags for expected operational failures across the Effect migration. */
export const JSCPD_EXPECTED_ERROR_TAGS = Object.freeze([
  "JscpdAnalyzerUnavailable",
  "JscpdProcessFailure",
  "JscpdFileSystemFailure",
  "JscpdOperationCancelled",
  "JscpdOperationTimedOut",
  "JscpdLimitExceeded",
  "JscpdInvalidInput",
  "JscpdStaleOperation",
  "JscpdWorkspaceFailure",
  "JscpdPersistenceFailure",
  "JscpdDeliveryFailure",
] as const);

export type JscpdOperationStage = "probe" | "scan" | "baseline" | "lifecycle";

export class JscpdAnalyzerUnavailable extends Data.TaggedError("JscpdAnalyzerUnavailable")<{
  readonly reason: "missing" | "incompatible";
}> {}

export class JscpdProcessFailure extends Data.TaggedError("JscpdProcessFailure")<{
  readonly stage: "probe" | "scan";
  readonly reason: "spawn" | "exit" | "termination";
}> {}

export class JscpdFileSystemFailure extends Data.TaggedError("JscpdFileSystemFailure")<{
  readonly operation: "canonicalize" | "metadata" | "read" | "write" | "remove";
  readonly reason: "missing" | "permission" | "not-regular" | "symlink" | "io";
}> {}

export class JscpdOperationCancelled extends Data.TaggedError("JscpdOperationCancelled")<{
  readonly stage: JscpdOperationStage;
}> {}

export class JscpdOperationTimedOut extends Data.TaggedError("JscpdOperationTimedOut")<{
  readonly stage: Exclude<JscpdOperationStage, "lifecycle">;
}> {}

export class JscpdLimitExceeded extends Data.TaggedError("JscpdLimitExceeded")<{
  readonly subject: "process-output" | "report" | "configuration" | "path" | "message" | "state";
}> {}

export class JscpdInvalidInput extends Data.TaggedError("JscpdInvalidInput")<{
  readonly subject: "configuration" | "path" | "report";
  readonly reason: "unsafe" | "unsupported" | "malformed" | "incompatible" | "invalid";
}> {}

export class JscpdStaleOperation extends Data.TaggedError("JscpdStaleOperation")<{
  readonly operation: "baseline" | "scan" | "automatic" | "verification";
}> {}

export class JscpdWorkspaceFailure extends Data.TaggedError("JscpdWorkspaceFailure")<{
  readonly operation: "create" | "read-report" | "cleanup";
}> {}

export class JscpdPersistenceFailure extends Data.TaggedError("JscpdPersistenceFailure")<{
  readonly operation: "restore" | "append";
}> {}

export class JscpdDeliveryFailure extends Data.TaggedError("JscpdDeliveryFailure")<{
  readonly channel: "message" | "notification" | "status";
}> {}

export type JscpdExpectedError =
  | JscpdAnalyzerUnavailable
  | JscpdProcessFailure
  | JscpdFileSystemFailure
  | JscpdOperationCancelled
  | JscpdOperationTimedOut
  | JscpdLimitExceeded
  | JscpdInvalidInput
  | JscpdStaleOperation
  | JscpdWorkspaceFailure
  | JscpdPersistenceFailure
  | JscpdDeliveryFailure;

export const JSCPD_EXPECTED_ERROR_MESSAGE_MAX_LENGTH = 240;

type PublicResultMapping =
  | {
      readonly disposition: "result";
      readonly status: "unavailable";
      readonly reason: JscpdUnavailableReason;
      readonly message: string;
    }
  | {
      readonly disposition: "result";
      readonly status: "failed";
      readonly reason: JscpdScanFailureReason;
      readonly message: string;
    }
  | {
      readonly disposition: "result";
      readonly status: "changed-unavailable";
      readonly reason: JscpdChangedUnavailableReason;
      readonly message: string;
    }
  | {
      readonly disposition: "diagnostic" | "defer" | "ignore";
      readonly reason:
        | "invalid-configuration"
        | "stale-operation"
        | "bounded-state"
        | "delivery-failed"
        | "persistence-failed";
      readonly message: string;
    };

/**
 * Foundation mapping only. Production adapters continue using their current mappings until the
 * owning migration slices replace them; this function fixes bounded public intent meanwhile.
 */
export function mapJscpdExpectedError(error: JscpdExpectedError): PublicResultMapping {
  const mapper = expectedErrorMappers[error._tag] as (
    candidate: JscpdExpectedError,
  ) => PublicResultMapping;
  return mapper(error);
}

type ExpectedErrorMappers = {
  readonly [Error in JscpdExpectedError as Error["_tag"]]: (error: Error) => PublicResultMapping;
};

const expectedErrorMappers = {
  JscpdAnalyzerUnavailable: mapAnalyzerUnavailable,
  JscpdProcessFailure: mapProcessFailure,
  JscpdFileSystemFailure: mapFileSystemFailure,
  JscpdOperationCancelled: mapOperationCancelled,
  JscpdOperationTimedOut: mapOperationTimedOut,
  JscpdLimitExceeded: mapLimitExceeded,
  JscpdInvalidInput: mapInvalidInput,
  JscpdStaleOperation: mapStaleOperation,
  JscpdWorkspaceFailure: mapWorkspaceFailure,
  JscpdPersistenceFailure: mapPersistenceFailure,
  JscpdDeliveryFailure: mapDeliveryFailure,
} satisfies ExpectedErrorMappers;

function mapAnalyzerUnavailable(error: JscpdAnalyzerUnavailable): PublicResultMapping {
  return publicResult(
    "unavailable",
    error.reason === "missing" ? "missing-binary" : "incompatible-version",
    "jscpd is unavailable; reinstall pi-jscpd or use a compatible jscpd v5 installation.",
  );
}

function mapProcessFailure(error: JscpdProcessFailure): PublicResultMapping {
  return error.stage === "probe"
    ? publicResult("unavailable", "probe-failed", "The jscpd probe failed safely.")
    : publicResult("failed", "process-failed", "The jscpd process did not complete safely.");
}

function mapFileSystemFailure(error: JscpdFileSystemFailure): PublicResultMapping {
  return error.operation === "read"
    ? publicResult("failed", "missing-report", "The bounded jscpd report could not be read.")
    : publicResult("failed", "process-failed", "A required bounded filesystem operation failed.");
}

function mapOperationCancelled(error: JscpdOperationCancelled): PublicResultMapping {
  const mappings = {
    probe: publicResult("unavailable", "probe-cancelled", "The jscpd probe was cancelled."),
    scan: publicResult("failed", "scan-cancelled", "The jscpd scan was cancelled."),
    baseline: publicResult(
      "changed-unavailable",
      "baseline-cancelled",
      "The session baseline was cancelled; a later changed check can retry.",
    ),
    lifecycle: publicResult(
      "changed-unavailable",
      "baseline-cancelled",
      "The session baseline was cancelled; a later changed check can retry.",
    ),
  } satisfies Record<JscpdOperationStage, PublicResultMapping>;
  return mappings[error.stage];
}

function mapOperationTimedOut(error: JscpdOperationTimedOut): PublicResultMapping {
  const mappings = {
    probe: publicResult("unavailable", "probe-timed-out", "The jscpd probe timed out."),
    scan: publicResult("failed", "scan-timed-out", "The jscpd scan timed out."),
    baseline: publicResult(
      "changed-unavailable",
      "baseline-timed-out",
      "The session baseline timed out; explicit project scans remain available.",
    ),
  } satisfies Record<JscpdOperationTimedOut["stage"], PublicResultMapping>;
  return mappings[error.stage];
}

function mapLimitExceeded(error: JscpdLimitExceeded): PublicResultMapping {
  if (error.subject === "configuration") {
    return boundedDisposition(
      "diagnostic",
      "invalid-configuration",
      "Oversized jscpd guardrail configuration was ignored.",
    );
  }
  if (error.subject === "message" || error.subject === "state") {
    return boundedDisposition("defer", "bounded-state", "Oversized advisory data was omitted.");
  }
  return publicResult(
    "failed",
    error.subject === "report" ? "invalid-report" : "process-failed",
    "The jscpd operation exceeded a configured safety limit.",
  );
}

function mapInvalidInput(error: JscpdInvalidInput): PublicResultMapping {
  if (error.subject === "configuration") {
    return boundedDisposition(
      "diagnostic",
      "invalid-configuration",
      "Invalid jscpd guardrail configuration was ignored.",
    );
  }
  return error.subject === "path" ? mapInvalidPath(error) : mapInvalidReport(error);
}

function mapInvalidPath(error: JscpdInvalidInput): PublicResultMapping {
  const unsupported = error.reason === "unsupported";
  return publicResult(
    "failed",
    unsupported ? "unsupported-path" : "unsafe-path",
    unsupported
      ? "The requested scan path is unsupported."
      : "The requested scan path is outside the project or unsafe.",
  );
}

function mapInvalidReport(error: JscpdInvalidInput): PublicResultMapping {
  const reasons = {
    unsafe: "invalid-report",
    unsupported: "invalid-report",
    malformed: "malformed-report",
    incompatible: "incompatible-report",
    invalid: "invalid-report",
  } as const satisfies Record<JscpdInvalidInput["reason"], JscpdScanFailureReason>;
  return publicResult(
    "failed",
    reasons[error.reason],
    "jscpd returned an invalid or incompatible report.",
  );
}

function mapStaleOperation(_error: JscpdStaleOperation): PublicResultMapping {
  return boundedDisposition(
    "defer",
    "stale-operation",
    "A superseded jscpd result was discarded safely.",
  );
}

function mapWorkspaceFailure(error: JscpdWorkspaceFailure): PublicResultMapping {
  const reasons = {
    create: "process-failed",
    "read-report": "missing-report",
    cleanup: "cleanup-failed",
  } as const satisfies Record<JscpdWorkspaceFailure["operation"], JscpdScanFailureReason>;
  const messages = {
    create: "The temporary jscpd report workspace was unavailable.",
    "read-report": "The temporary jscpd report workspace was unavailable.",
    cleanup: "The temporary jscpd report workspace could not be confirmed clean.",
  } as const satisfies Record<JscpdWorkspaceFailure["operation"], string>;
  return publicResult("failed", reasons[error.operation], messages[error.operation]);
}

function mapPersistenceFailure(_error: JscpdPersistenceFailure): PublicResultMapping {
  return boundedDisposition(
    "ignore",
    "persistence-failed",
    "Advisory jscpd session state could not be persisted.",
  );
}

function mapDeliveryFailure(_error: JscpdDeliveryFailure): PublicResultMapping {
  return boundedDisposition(
    "defer",
    "delivery-failed",
    "The advisory jscpd update could not be delivered and may be retried.",
  );
}

function publicResult<
  Status extends "unavailable" | "failed" | "changed-unavailable",
  Reason extends JscpdUnavailableReason | JscpdScanFailureReason | JscpdChangedUnavailableReason,
>(status: Status, reason: Reason, message: string) {
  return Object.freeze({ disposition: "result" as const, status, reason, message });
}

function boundedDisposition(
  disposition: "diagnostic" | "defer" | "ignore",
  reason:
    | "invalid-configuration"
    | "stale-operation"
    | "bounded-state"
    | "delivery-failed"
    | "persistence-failed",
  message: string,
): PublicResultMapping {
  return Object.freeze({ disposition, reason, message });
}
