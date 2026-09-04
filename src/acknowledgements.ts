import { Context, Effect, Layer, MutableRef } from "effect";
import { isSafeChangedFilePath } from "./changed-files.js";
import { compareText } from "./path-utils.js";
import { hasExactKeys } from "./value-utils.js";

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
  readonly scopeEffect?: Effect.Effect<number>;
  revision(): number;
  readonly revisionEffect?: Effect.Effect<number>;
  findings(): readonly JscpdAcknowledgedFinding[];
  readonly findingsEffect?: Effect.Effect<readonly JscpdAcknowledgedFinding[]>;
  has(fingerprint: string): boolean;
  /** Drop acknowledgements touched by a verified source mutation. */
  invalidatePaths(paths: readonly string[]): boolean;
  /** Retain only active findings and add findings actually surfaced by this check. */
  reconcile(
    expectedRevision: number,
    active: readonly JscpdAcknowledgedFinding[],
    surfaced: readonly JscpdAcknowledgedFinding[],
  ): boolean;
  reconcileEffect?: (
    expectedRevision: number,
    active: readonly JscpdAcknowledgedFinding[],
    surfaced: readonly JscpdAcknowledgedFinding[],
  ) => Effect.Effect<boolean>;
}

interface AcknowledgementState {
  readonly scope: number;
  readonly revision: number;
  readonly findings: ReadonlyMap<string, JscpdAcknowledgedFinding>;
}

interface JscpdAcknowledgementEffectService {
  readonly restore: (value?: JscpdPersistedAcknowledgements) => Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
  readonly scope: Effect.Effect<number>;
  readonly revision: Effect.Effect<number>;
  readonly findings: Effect.Effect<readonly JscpdAcknowledgedFinding[]>;
  readonly has: (fingerprint: string) => Effect.Effect<boolean>;
  readonly invalidatePaths: (paths: readonly string[]) => Effect.Effect<boolean>;
  readonly reconcile: (
    expectedRevision: number,
    active: readonly JscpdAcknowledgedFinding[],
    surfaced: readonly JscpdAcknowledgedFinding[],
  ) => Effect.Effect<boolean>;
}

export const JscpdAcknowledgements = Context.GenericTag<JscpdAcknowledgementEffectService>(
  "pi-jscpd/effect/Acknowledgements",
);

const EMPTY: JscpdPersistedAcknowledgements = Object.freeze({
  identityVersion: JSCPD_ACKNOWLEDGEMENT_IDENTITY_VERSION,
  findings: Object.freeze([]),
});

/** Keep acknowledgement identities conservative, bounded, and owned by one active branch. */
export function createJscpdAcknowledgementTracker(): JscpdAcknowledgementTracker {
  return acknowledgementTrackerFor(new AcknowledgementOwner());
}

export function createJscpdAcknowledgementLayer() {
  const owner = new AcknowledgementOwner();
  return Layer.succeed(JscpdAcknowledgements, acknowledgementEffectServiceFor(owner));
}

class AcknowledgementOwner {
  readonly #state = MutableRef.make<AcknowledgementState>(initialAcknowledgementState());

  restore(value: JscpdPersistedAcknowledgements = EMPTY): void {
    const current = MutableRef.get(this.#state);
    MutableRef.set(this.#state, {
      scope: current.scope + 1,
      revision: current.revision + 1,
      findings: new Map(value.findings.map((finding) => [finding.fingerprint, finding])),
    });
  }

  reset(): void {
    const current = MutableRef.get(this.#state);
    MutableRef.set(this.#state, {
      scope: current.scope + 1,
      revision: current.revision + 1,
      findings: new Map(),
    });
  }

  scope(): number {
    return MutableRef.get(this.#state).scope;
  }

  revision(): number {
    return MutableRef.get(this.#state).revision;
  }

  findings(): readonly JscpdAcknowledgedFinding[] {
    return Object.freeze([...MutableRef.get(this.#state).findings.values()].sort(compareFinding));
  }

  has(fingerprint: string): boolean {
    return MutableRef.get(this.#state).findings.has(fingerprint);
  }

  invalidatePaths(paths: readonly string[]): boolean {
    const current = MutableRef.get(this.#state);
    const changed = new Set(paths);
    const findings = new Map(
      [...current.findings].filter(([, finding]) =>
        finding.paths.every((path) => !changed.has(path)),
      ),
    );
    if (findings.size === current.findings.size) return false;
    MutableRef.set(this.#state, { ...current, revision: current.revision + 1, findings });
    return true;
  }

  reconcile(
    expectedRevision: number,
    active: readonly JscpdAcknowledgedFinding[],
    surfaced: readonly JscpdAcknowledgedFinding[],
  ): boolean {
    const current = MutableRef.get(this.#state);
    if (current.revision !== expectedRevision) return false;
    const findings = reconciledFindings(current.findings, active, surfaced);
    MutableRef.set(this.#state, { ...current, revision: current.revision + 1, findings });
    return true;
  }
}

function initialAcknowledgementState(): AcknowledgementState {
  return { scope: 0, revision: 0, findings: new Map() };
}

function reconciledFindings(
  retained: ReadonlyMap<string, JscpdAcknowledgedFinding>,
  active: readonly JscpdAcknowledgedFinding[],
  surfaced: readonly JscpdAcknowledgedFinding[],
): ReadonlyMap<string, JscpdAcknowledgedFinding> {
  const surfacedFingerprints = new Set(
    surfaced.slice(0, MAX_ACKNOWLEDGED_FINDINGS).map(({ fingerprint }) => fingerprint),
  );
  const wantedFingerprints = new Set([...surfacedFingerprints, ...retained.keys()]);
  const activeByFingerprint = new Map(
    active
      .filter((finding) => wantedFingerprints.has(finding.fingerprint))
      .map((finding) => [finding.fingerprint, finding]),
  );
  const next = new Map<string, JscpdAcknowledgedFinding>();
  appendActiveFindings(next, surfacedFingerprints, activeByFingerprint);
  appendActiveFindings(next, retained.keys(), activeByFingerprint);
  return next;
}

function appendActiveFindings(
  target: Map<string, JscpdAcknowledgedFinding>,
  fingerprints: Iterable<string>,
  active: ReadonlyMap<string, JscpdAcknowledgedFinding>,
): void {
  for (const fingerprint of fingerprints) {
    if (target.size >= MAX_ACKNOWLEDGED_FINDINGS) break;
    const finding = active.get(fingerprint);
    if (finding) target.set(fingerprint, finding);
  }
}

function acknowledgementTrackerFor(owner: AcknowledgementOwner): JscpdAcknowledgementTracker {
  return {
    restore: (value) => owner.restore(value),
    reset: () => owner.reset(),
    scope: () => owner.scope(),
    scopeEffect: Effect.sync(() => owner.scope()),
    revision: () => owner.revision(),
    revisionEffect: Effect.sync(() => owner.revision()),
    findings: () => owner.findings(),
    findingsEffect: Effect.sync(() => owner.findings()),
    has: (fingerprint) => owner.has(fingerprint),
    invalidatePaths: (paths) => owner.invalidatePaths(paths),
    reconcile: (revision, active, surfaced) => owner.reconcile(revision, active, surfaced),
    reconcileEffect: (revision, active, surfaced) =>
      Effect.sync(() => owner.reconcile(revision, active, surfaced)),
  };
}

function acknowledgementEffectServiceFor(
  owner: AcknowledgementOwner,
): JscpdAcknowledgementEffectService {
  return {
    restore: (value) => Effect.sync(() => owner.restore(value)),
    reset: Effect.sync(() => owner.reset()),
    scope: Effect.sync(() => owner.scope()),
    revision: Effect.sync(() => owner.revision()),
    findings: Effect.sync(() => owner.findings()),
    has: (fingerprint) => Effect.sync(() => owner.has(fingerprint)),
    invalidatePaths: (paths) => Effect.sync(() => owner.invalidatePaths(paths)),
    reconcile: (revision, active, surfaced) =>
      Effect.sync(() => owner.reconcile(revision, active, surfaced)),
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
  if (!hasExactKeys(value, ["identityVersion", "findings"])) return undefined;
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
  if (!hasExactKeys(value, ["fingerprint", "paths"])) return undefined;
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
