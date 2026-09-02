import {
  emptyJscpdAcknowledgements,
  type JscpdAcknowledgementTracker,
  type JscpdPersistedAcknowledgements,
  parseJscpdAcknowledgements,
  snapshotJscpdAcknowledgements,
} from "./acknowledgements.js";
import {
  isSafeChangedFilePath,
  type JscpdChangedFileTracker,
  MAX_CHANGED_FILES,
} from "./changed-files.js";
import type { JscpdSessionModeService, JscpdStatusService } from "./status.js";
import type { JscpdLastCheck, JscpdScanFailureReason, JscpdUnavailableReason } from "./types.js";

export const JSCPD_SESSION_STATE_TYPE = "pi-jscpd/session-state";
export const JSCPD_SESSION_STATE_VERSION = 3;

export type JscpdSessionModeOverride = "enabled" | "disabled" | null;

export interface JscpdPersistedSessionState {
  readonly version: typeof JSCPD_SESSION_STATE_VERSION;
  readonly modeOverride: JscpdSessionModeOverride;
  readonly lastCheck: JscpdLastCheck;
  readonly changedFiles: readonly string[];
  readonly acknowledgements: JscpdPersistedAcknowledgements;
}

const SCAN_FAILURE_REASONS = new Set<JscpdScanFailureReason>([
  "unsafe-path",
  "unsupported-path",
  "scan-cancelled",
  "scan-timed-out",
  "process-failed",
  "missing-report",
  "malformed-report",
  "incompatible-report",
  "invalid-report",
  "cleanup-failed",
]);

const UNAVAILABLE_REASONS = new Set<JscpdUnavailableReason>([
  "disabled",
  "missing-binary",
  "incompatible-version",
  "probe-cancelled",
  "probe-timed-out",
  "probe-failed",
]);

const MAX_RESTORED_CLONES = 1_000;

/** Build the only extension state written to Pi's branch-local custom entries. */
export function snapshotJscpdSessionState(
  mode: JscpdSessionModeService,
  status: JscpdStatusService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
): JscpdPersistedSessionState {
  return Object.freeze({
    version: JSCPD_SESSION_STATE_VERSION,
    modeOverride: mode.override(),
    lastCheck: status.lastCheck(),
    changedFiles: Object.freeze([...changedFiles.files()]),
    acknowledgements: snapshotJscpdAcknowledgements(acknowledgements),
  });
}

/**
 * Restore only the latest pi-jscpd entry on the supplied active branch.
 * A malformed or unsupported latest entry resets state instead of reviving an older snapshot.
 */
export function restoreJscpdSessionState(
  activeBranch: readonly unknown[],
): JscpdPersistedSessionState | undefined {
  for (let index = activeBranch.length - 1; index >= 0; index -= 1) {
    const entry = activeBranch[index];
    if (!isJscpdCustomEntry(entry)) continue;
    return parsePersistedState(entry.data);
  }
  return undefined;
}

function isJscpdCustomEntry(
  value: unknown,
): value is { type: "custom"; customType: typeof JSCPD_SESSION_STATE_TYPE; data: unknown } {
  if (!isRecord(value)) return false;
  return value.type === "custom" && value.customType === JSCPD_SESSION_STATE_TYPE;
}

function parsePersistedState(value: unknown): JscpdPersistedSessionState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === 1) return migrateVersionOneState(value);
  if (value.version === 2) return migrateVersionTwoState(value);
  if (value.version !== JSCPD_SESSION_STATE_VERSION) return undefined;
  if (
    !hasExactKeys(value, [
      "version",
      "modeOverride",
      "lastCheck",
      "changedFiles",
      "acknowledgements",
    ])
  ) {
    return undefined;
  }
  return parseStateFields(
    value.modeOverride,
    value.lastCheck,
    value.changedFiles,
    value.acknowledgements,
  );
}

/** Preserve pre-M3 session controls/status while starting changed-file attribution empty. */
function migrateVersionOneState(value: unknown): JscpdPersistedSessionState | undefined {
  if (!hasExactKeys(value, ["version", "modeOverride", "lastCheck"]) || value.version !== 1) {
    return undefined;
  }
  return parseStateFields(value.modeOverride, value.lastCheck, [], emptyJscpdAcknowledgements());
}

/** Preserve M3 changed-file attribution while starting acknowledgement identity v1 empty. */
function migrateVersionTwoState(value: unknown): JscpdPersistedSessionState | undefined {
  if (
    !hasExactKeys(value, ["version", "modeOverride", "lastCheck", "changedFiles"]) ||
    value.version !== 2
  ) {
    return undefined;
  }
  return parseStateFields(
    value.modeOverride,
    value.lastCheck,
    value.changedFiles,
    emptyJscpdAcknowledgements(),
  );
}

function parseStateFields(
  modeOverride: unknown,
  lastCheckValue: unknown,
  changedFilesValue: unknown,
  acknowledgementsValue: unknown,
): JscpdPersistedSessionState | undefined {
  if (modeOverride !== null && modeOverride !== "enabled" && modeOverride !== "disabled") {
    return undefined;
  }
  const lastCheck = parseLastCheck(lastCheckValue);
  const changedFiles = parseChangedFiles(changedFilesValue);
  const acknowledgements = parseJscpdAcknowledgements(acknowledgementsValue);
  if (!lastCheck || !changedFiles || !acknowledgements) return undefined;
  return Object.freeze({
    version: JSCPD_SESSION_STATE_VERSION,
    modeOverride,
    lastCheck,
    changedFiles,
    acknowledgements,
  });
}

function parseChangedFiles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_FILES) return undefined;
  const files: string[] = [];
  const seen = new Set<string>();
  for (const path of value) {
    if (!isSafeChangedFilePath(path) || seen.has(path)) return undefined;
    seen.add(path);
    files.push(path);
  }
  return Object.freeze(files);
}

function parseLastCheck(value: unknown): JscpdLastCheck | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.state) {
    case "never":
    case "clean":
    case "cancelled":
      return parseSimpleLastCheck(value, value.state);
    case "findings":
      return parseFindingsLastCheck(value);
    case "failed":
      return parseFailedLastCheck(value);
    default:
      return undefined;
  }
}

function parseSimpleLastCheck(
  value: unknown,
  state: "never" | "clean" | "cancelled",
): JscpdLastCheck | undefined {
  if (!hasExactKeys(value, ["state"])) return undefined;
  return Object.freeze({ state });
}

function parseFindingsLastCheck(value: unknown): JscpdLastCheck | undefined {
  if (!hasExactKeys(value, ["state", "clones"])) return undefined;
  if (!isRestorableCloneCount(value.clones)) return undefined;
  return Object.freeze({ state: "findings", clones: value.clones });
}

function parseFailedLastCheck(value: unknown): JscpdLastCheck | undefined {
  if (!hasExactKeys(value, ["state", "reason"])) return undefined;
  if (!isFailureReason(value.reason)) return undefined;
  return Object.freeze({ state: "failed", reason: value.reason });
}

function isRestorableCloneCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_RESTORED_CLONES;
}

function isFailureReason(value: unknown): value is JscpdScanFailureReason | JscpdUnavailableReason {
  if (typeof value !== "string") return false;
  return (
    SCAN_FAILURE_REASONS.has(value as JscpdScanFailureReason) ||
    UNAVAILABLE_REASONS.has(value as JscpdUnavailableReason)
  );
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  expected: T,
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
