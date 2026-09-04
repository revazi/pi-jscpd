import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { runFileSystemEffectForTest } from "./effect/runtime-boundary.js";
import { JscpdFileSystem } from "./effect/services.js";
import { canonicalDirectoryEffect, isPathInside } from "./path-utils.js";
import type { JscpdCloneOccurrence, JscpdClonePair, JscpdScanReport } from "./types.js";

const MAX_IDENTITY_BLOCK_BYTES = 1024 * 1024;
const DIGEST_ALGORITHM = "sha256";

export type JscpdCloneIdentityIssue =
  | "invalid-project"
  | "malformed-group"
  | "unsafe-path"
  | "missing-source"
  | "invalid-range"
  | "block-too-large"
  | "read-failed";

export interface JscpdIndexedCloneGroup {
  readonly clone: JscpdClonePair;
  /** Opaque internal group digest; persisted only behind an explicit identity-version marker. */
  readonly fingerprint?: string;
  /** Opaque occurrence digests in the report's occurrence order. */
  readonly occurrenceFingerprints?: readonly [string, string];
  readonly issue?: JscpdCloneIdentityIssue;
}

export interface JscpdCloneSnapshot {
  readonly status: "accepted" | "partial";
  readonly groups: readonly JscpdIndexedCloneGroup[];
  /** Runtime-malformed groups that could not safely retain a clone value. */
  readonly omittedGroups: number;
}

export interface JscpdAmbiguousCloneGroups {
  readonly reason: "identity-unavailable" | "non-unique-identity";
  readonly baseline: readonly JscpdClonePair[];
  readonly current: readonly JscpdClonePair[];
}

export interface JscpdBaselineComparison {
  readonly existing: readonly JscpdClonePair[];
  readonly new: readonly JscpdClonePair[];
  readonly removed: readonly JscpdClonePair[];
  readonly ambiguous: readonly JscpdAmbiguousCloneGroups[];
}

interface OccurrenceIdentity {
  readonly path: string;
  readonly contentDigest: string;
}

type OccurrenceIdentityResult =
  | { readonly ok: true; readonly value: OccurrenceIdentity }
  | { readonly ok: false; readonly issue: JscpdCloneIdentityIssue };

/**
 * Derive content-aware identities immediately while report offsets still address this source tree.
 * Line, column, and byte positions are deliberately excluded from the final group fingerprint.
 */
export async function indexJscpdCloneReport(
  report: JscpdScanReport,
  cwd: string,
): Promise<JscpdCloneSnapshot> {
  return runFileSystemEffectForTest(indexJscpdCloneReportEffect(report, cwd));
}

export function indexJscpdCloneReportEffect(
  report: JscpdScanReport,
  cwd: string,
): Effect.Effect<JscpdCloneSnapshot, never, JscpdFileSystem> {
  const clonePairs = runtimeClonePairs(report);
  if (!clonePairs) return Effect.succeed(partialSnapshot([], 0));
  return canonicalDirectoryEffect(cwd).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
    Effect.flatMap((project) =>
      project
        ? Effect.forEach(clonePairs, (clone) => indexCloneGroupEffect(clone, project), {
            concurrency: "unbounded",
          }).pipe(
            Effect.map((groups) =>
              Object.freeze({
                status: groups.some((group) => group.issue) ? "partial" : "accepted",
                groups: Object.freeze(groups),
                omittedGroups: 0,
              }),
            ),
          )
        : Effect.succeed(partialSnapshot([], clonePairs.length)),
    ),
  );
}

/** Compare opaque identities conservatively; duplicate or unavailable identities stay ambiguous. */
export function compareJscpdCloneSnapshots(
  baseline: JscpdCloneSnapshot,
  current: JscpdCloneSnapshot,
): JscpdBaselineComparison {
  const existing: JscpdClonePair[] = [];
  const added: JscpdClonePair[] = [];
  const removed: JscpdClonePair[] = [];
  const ambiguous: JscpdAmbiguousCloneGroups[] = [];
  const baselineByIdentity = groupByFingerprint(baseline.groups, ambiguous, "baseline");
  const currentByIdentity = groupByFingerprint(current.groups, ambiguous, "current");
  const identities = [
    ...new Set([...baselineByIdentity.keys(), ...currentByIdentity.keys()]),
  ].sort();

  for (const identity of identities) {
    classifyIdentity(
      baselineByIdentity.get(identity) ?? [],
      currentByIdentity.get(identity) ?? [],
      baseline.status === "partial",
      current.status === "partial",
      existing,
      added,
      removed,
      ambiguous,
    );
  }
  if (hasUnrepresentedPartialInput(baseline) || hasUnrepresentedPartialInput(current)) {
    ambiguous.push(freezeAmbiguous("identity-unavailable", [], []));
  }

  return Object.freeze({
    existing: Object.freeze(existing),
    new: Object.freeze(added),
    removed: Object.freeze(removed),
    ambiguous: Object.freeze(ambiguous),
  });
}

function runtimeClonePairs(report: JscpdScanReport): readonly JscpdClonePair[] | undefined {
  if (!report || typeof report !== "object" || !Array.isArray(report.clonePairs)) return undefined;
  return report.clonePairs;
}

function indexCloneGroupEffect(
  clone: JscpdClonePair,
  project: string,
): Effect.Effect<JscpdIndexedCloneGroup, never, JscpdFileSystem> {
  if (!isClonePair(clone)) {
    return Effect.succeed(Object.freeze({ clone, issue: "malformed-group" }));
  }
  return Effect.all(
    [
      occurrenceIdentityEffect(clone.occurrences[0], project),
      occurrenceIdentityEffect(clone.occurrences[1], project),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([first, second]) => {
      if (!first.ok) return Object.freeze({ clone, issue: first.issue });
      if (!second.ok) return Object.freeze({ clone, issue: second.issue });
      const occurrenceFingerprints = Object.freeze([
        fingerprintOccurrence(first.value),
        fingerprintOccurrence(second.value),
      ] as const);
      const sortedOccurrences = [...occurrenceFingerprints].sort();
      return Object.freeze({
        clone,
        fingerprint: digest(
          JSON.stringify([clone.format, clone.lines, clone.tokens, sortedOccurrences]),
        ),
        occurrenceFingerprints,
      });
    }),
  );
}

function isClonePair(value: unknown): value is JscpdClonePair {
  if (!value || typeof value !== "object") return false;
  const clone = value as Partial<JscpdClonePair>;
  return (
    typeof clone.format === "string" &&
    Number.isSafeInteger(clone.lines) &&
    Number.isSafeInteger(clone.tokens) &&
    Array.isArray(clone.occurrences) &&
    clone.occurrences.length === 2
  );
}

function occurrenceIdentityEffect(
  occurrence: JscpdCloneOccurrence,
  project: string,
): Effect.Effect<OccurrenceIdentityResult, never, JscpdFileSystem> {
  if (!isOccurrence(occurrence)) {
    return Effect.succeed({ ok: false, issue: "malformed-group" });
  }
  const candidate = join(project, occurrence.path);
  if (!isPathInside(project, candidate)) return Effect.succeed({ ok: false, issue: "unsafe-path" });

  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem.canonicalize(candidate).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ ok: false, issue: "missing-source" } as const),
        onSuccess: (canonical) =>
          occurrenceIdentityFromCanonical(filesystem, occurrence, project, canonical),
      }),
    ),
  );
}

function occurrenceIdentityFromCanonical(
  filesystem: JscpdFileSystem,
  occurrence: JscpdCloneOccurrence,
  project: string,
  canonical: string,
): Effect.Effect<OccurrenceIdentityResult> {
  if (!isPathInside(project, canonical)) {
    return Effect.succeed({ ok: false, issue: "unsafe-path" } as const);
  }
  const length = occurrence.end.offset - occurrence.start.offset;
  if (!Number.isSafeInteger(length) || length <= 0) {
    return Effect.succeed({ ok: false, issue: "invalid-range" } as const);
  }
  if (length > MAX_IDENTITY_BLOCK_BYTES) {
    return Effect.succeed({ ok: false, issue: "block-too-large" } as const);
  }
  return filesystem
    .read({
      path: canonical,
      maxBytes: MAX_IDENTITY_BLOCK_BYTES,
      regularFileOnly: true,
      noFollow: true,
      offset: occurrence.start.offset,
      length,
      limitSubject: "report",
    })
    .pipe(
      Effect.match({
        onFailure: () => ({ ok: false, issue: "read-failed" }) as const,
        onSuccess: (content) => ({
          ok: true,
          value: Object.freeze({ path: occurrence.path, contentDigest: digest(content) }),
        }),
      }),
    );
}

function isOccurrence(value: unknown): value is JscpdCloneOccurrence {
  if (!value || typeof value !== "object") return false;
  const occurrence = value as Partial<JscpdCloneOccurrence>;
  if (!isIdentityPath(occurrence.path)) return false;
  if (!hasSafeOffset(occurrence.start) || !hasSafeOffset(occurrence.end)) return false;
  return occurrence.end.offset >= occurrence.start.offset;
}

function isIdentityPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return !isAbsolute(value) && !value.includes("\\");
}

function hasSafeOffset(
  value: JscpdCloneOccurrence["start"] | undefined,
): value is JscpdCloneOccurrence["start"] {
  if (!value || !Number.isSafeInteger(value.offset)) return false;
  return value.offset >= 0;
}

function hasUnrepresentedPartialInput(snapshot: JscpdCloneSnapshot): boolean {
  if (snapshot.status !== "partial") return false;
  return snapshot.omittedGroups > 0 || snapshot.groups.every((group) => !!group.fingerprint);
}

function groupByFingerprint(
  groups: readonly JscpdIndexedCloneGroup[],
  ambiguous: JscpdAmbiguousCloneGroups[],
  side: "baseline" | "current",
): Map<string, JscpdClonePair[]> {
  const grouped = new Map<string, JscpdClonePair[]>();
  for (const group of groups) {
    if (!group.fingerprint) {
      ambiguous.push(
        freezeAmbiguous(
          "identity-unavailable",
          side === "baseline" ? [group.clone] : [],
          side === "current" ? [group.clone] : [],
        ),
      );
      continue;
    }
    const matches = grouped.get(group.fingerprint) ?? [];
    matches.push(group.clone);
    grouped.set(group.fingerprint, matches);
  }
  return grouped;
}

function classifyIdentity(
  baseline: readonly JscpdClonePair[],
  current: readonly JscpdClonePair[],
  baselineIncomplete: boolean,
  currentIncomplete: boolean,
  existing: JscpdClonePair[],
  added: JscpdClonePair[],
  removed: JscpdClonePair[],
  ambiguous: JscpdAmbiguousCloneGroups[],
): void {
  switch (`${baseline.length}:${current.length}`) {
    case "1:1":
      classifyExisting(baseline, current, existing, ambiguous);
      return;
    case "0:1":
      classifyAdded(baseline, current, baselineIncomplete, added, ambiguous);
      return;
    case "1:0":
      classifyRemoved(baseline, current, currentIncomplete, removed, ambiguous);
      return;
    default:
      ambiguous.push(freezeAmbiguous("non-unique-identity", baseline, current));
  }
}

function classifyExisting(
  baseline: readonly JscpdClonePair[],
  current: readonly JscpdClonePair[],
  existing: JscpdClonePair[],
  ambiguous: JscpdAmbiguousCloneGroups[],
): void {
  const group = current[0];
  if (group) existing.push(group);
  else ambiguous.push(freezeAmbiguous("identity-unavailable", baseline, current));
}

function classifyAdded(
  baseline: readonly JscpdClonePair[],
  current: readonly JscpdClonePair[],
  baselineIncomplete: boolean,
  added: JscpdClonePair[],
  ambiguous: JscpdAmbiguousCloneGroups[],
): void {
  const group = current[0];
  if (group && !baselineIncomplete) added.push(group);
  else ambiguous.push(freezeAmbiguous("identity-unavailable", baseline, current));
}

function classifyRemoved(
  baseline: readonly JscpdClonePair[],
  current: readonly JscpdClonePair[],
  currentIncomplete: boolean,
  removed: JscpdClonePair[],
  ambiguous: JscpdAmbiguousCloneGroups[],
): void {
  const group = baseline[0];
  if (group && !currentIncomplete) removed.push(group);
  else ambiguous.push(freezeAmbiguous("identity-unavailable", baseline, current));
}

function freezeAmbiguous(
  reason: JscpdAmbiguousCloneGroups["reason"],
  baseline: readonly JscpdClonePair[],
  current: readonly JscpdClonePair[],
): JscpdAmbiguousCloneGroups {
  return Object.freeze({
    reason,
    baseline: Object.freeze([...baseline]),
    current: Object.freeze([...current]),
  });
}

function partialSnapshot(
  groups: readonly JscpdIndexedCloneGroup[],
  omittedGroups: number,
): JscpdCloneSnapshot {
  return Object.freeze({
    status: "partial",
    groups: Object.freeze([...groups]),
    omittedGroups,
  });
}

function fingerprintOccurrence(value: OccurrenceIdentity): string {
  return digest(JSON.stringify([value.path, value.contentDigest]));
}

function digest(value: string | Uint8Array): string {
  return createHash(DIGEST_ALGORITHM).update(value).digest("hex");
}
