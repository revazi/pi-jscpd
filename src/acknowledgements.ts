import { isSafeChangedFilePath } from "./changed-files.js";
import { compareText } from "./path-utils.js";

const JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION = 1;
export const MAX_ACKNOWLEDGED_FINDINGS = 1_000;

export interface JscpdAcknowledgedFinding {
  /** Opaque issue-19 clone-group identity, scoped by identityVersion. */
  readonly fingerprint: string;
  readonly paths: readonly [string, string];
}

export interface JscpdPersistedAcknowledgements {
  readonly identityVersion: typeof JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION;
  readonly findings: readonly JscpdAcknowledgedFinding[];
}

export interface JscpdAcknowledgementTracker {
  restore(value?: JscpdPersistedAcknowledgements): void;
  reset(): void;
  /** Lifecycle generation for active-branch isolation. */
  scope(): number;
  revision(): number;
  findings(): readonly JscpdAcknowledgedFinding[];
  has(fingerprint: string): boolean;
  /** Drop acknowledgements touched by a verified source mutation. */
  invalidatePaths(paths: readonly string[]): boolean;
  /** Retain only active findings and add findings actually surfaced by this check. */
  reconcile(
    expectedRevision: number,
    active: readonly JscpdAcknowledgedFinding[],
    surfaced: readonly JscpdAcknowledgedFinding[],
  ): boolean;
}

const EMPTY: JscpdPersistedAcknowledgements = Object.freeze({
  identityVersion: JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION,
  findings: Object.freeze([]),
});

/** Keep acknowledgement identities conservative, bounded, and owned by one active branch. */
export function createJscpdAcknowledgementTracker(): JscpdAcknowledgementTracker {
  let scope = 0;
  let revision = 0;
  let findings = new Map<string, JscpdAcknowledgedFinding>();

  return {
    restore(value = EMPTY) {
      scope += 1;
      revision += 1;
      findings = new Map(value.findings.map((finding) => [finding.fingerprint, finding]));
    },
    reset() {
      scope += 1;
      revision += 1;
      findings = new Map();
    },
    scope: () => scope,
    revision: () => revision,
    findings: () => Object.freeze([...findings.values()].sort(compareFinding)),
    has: (fingerprint) => findings.has(fingerprint),
    invalidatePaths(paths) {
      const changed = new Set(paths);
      let removed = false;
      for (const [fingerprint, finding] of findings) {
        if (!finding.paths.some((path) => changed.has(path))) continue;
        findings.delete(fingerprint);
        removed = true;
      }
      if (removed) revision += 1;
      return removed;
    },
    reconcile(expectedRevision, active, surfaced) {
      if (revision !== expectedRevision) return false;
      const surfacedFingerprints = new Set(
        surfaced.slice(0, MAX_ACKNOWLEDGED_FINDINGS).map(({ fingerprint }) => fingerprint),
      );
      const wantedFingerprints = new Set([...surfacedFingerprints, ...findings.keys()]);
      const activeByFingerprint = new Map<string, JscpdAcknowledgedFinding>();
      for (const finding of active) {
        if (wantedFingerprints.has(finding.fingerprint)) {
          activeByFingerprint.set(finding.fingerprint, finding);
        }
      }
      const next = new Map<string, JscpdAcknowledgedFinding>();
      for (const fingerprint of surfacedFingerprints) {
        const current = activeByFingerprint.get(fingerprint);
        if (current) next.set(fingerprint, current);
      }
      for (const fingerprint of findings.keys()) {
        if (next.size >= MAX_ACKNOWLEDGED_FINDINGS) break;
        const current = activeByFingerprint.get(fingerprint);
        if (current) next.set(fingerprint, current);
      }
      findings = next;
      revision += 1;
      return true;
    },
  };
}

export function emptyJscpdAcknowledgements(): JscpdPersistedAcknowledgements {
  return EMPTY;
}

export function snapshotJscpdAcknowledgements(
  tracker: JscpdAcknowledgementTracker,
): JscpdPersistedAcknowledgements {
  return Object.freeze({
    identityVersion: JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION,
    findings: Object.freeze([...tracker.findings()]),
  });
}

export function parseJscpdAcknowledgements(
  value: unknown,
): JscpdPersistedAcknowledgements | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["identityVersion", "findings"])) return undefined;
  if (value.identityVersion !== JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION) return undefined;
  if (!Array.isArray(value.findings) || value.findings.length > MAX_ACKNOWLEDGED_FINDINGS) {
    return undefined;
  }
  const findings: JscpdAcknowledgedFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of value.findings) {
    const finding = parseFinding(candidate);
    if (!finding || seen.has(finding.fingerprint)) return undefined;
    seen.add(finding.fingerprint);
    findings.push(finding);
  }
  return Object.freeze({
    identityVersion: JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION,
    findings: Object.freeze(findings.sort(compareFinding)),
  });
}

function parseFinding(value: unknown): JscpdAcknowledgedFinding | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["fingerprint", "paths"])) return undefined;
  if (typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
    return undefined;
  }
  if (!Array.isArray(value.paths) || value.paths.length !== 2) return undefined;
  const [first, second] = value.paths;
  if (!isSafeChangedFilePath(first) || !isSafeChangedFilePath(second)) return undefined;
  const paths = [first, second].sort(compareText) as [string, string];
  return Object.freeze({ fingerprint: value.fingerprint, paths: Object.freeze(paths) });
}

function compareFinding(first: JscpdAcknowledgedFinding, second: JscpdAcknowledgedFinding): number {
  return compareText(first.fingerprint, second.fingerprint);
}

function hasExactKeys<T extends readonly string[]>(
  value: Record<string, unknown>,
  expected: T,
): value is Record<T[number], unknown> {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
