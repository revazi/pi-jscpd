import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canonicalDirectory, isPathInside } from "./path-utils.js";
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

/**
 * Derive content-aware identities immediately while report offsets still address this source tree.
 * Line, column, and byte positions are deliberately excluded from the final group fingerprint.
 */
export async function indexJscpdCloneReport(
  report: JscpdScanReport,
  cwd: string,
): Promise<JscpdCloneSnapshot> {
  const project = await canonicalDirectory(cwd);
  const clonePairs = runtimeClonePairs(report);
  if (!project || !clonePairs) {
    return partialSnapshot([], clonePairs ? clonePairs.length : 0);
  }

  const groups = await Promise.all(clonePairs.map((clone) => indexCloneGroup(clone, project)));
  return Object.freeze({
    status: groups.some((group) => group.issue) ? "partial" : "accepted",
    groups: Object.freeze(groups),
    omittedGroups: 0,
  });
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

async function indexCloneGroup(
  clone: JscpdClonePair,
  project: string,
): Promise<JscpdIndexedCloneGroup> {
  if (!isClonePair(clone)) return Object.freeze({ clone, issue: "malformed-group" });
  const [first, second] = await Promise.all([
    occurrenceIdentity(clone.occurrences[0], project),
    occurrenceIdentity(clone.occurrences[1], project),
  ]);
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

async function occurrenceIdentity(
  occurrence: JscpdCloneOccurrence,
  project: string,
): Promise<
  { ok: true; value: OccurrenceIdentity } | { ok: false; issue: JscpdCloneIdentityIssue }
> {
  if (!isOccurrence(occurrence)) return { ok: false, issue: "malformed-group" };
  const candidate = join(project, occurrence.path);
  if (!isPathInside(project, candidate)) return { ok: false, issue: "unsafe-path" };

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    return { ok: false, issue: "missing-source" };
  }
  if (!isPathInside(project, canonical)) return { ok: false, issue: "unsafe-path" };

  const length = occurrence.end.offset - occurrence.start.offset;
  if (!Number.isSafeInteger(length) || length <= 0) return { ok: false, issue: "invalid-range" };
  if (length > MAX_IDENTITY_BLOCK_BYTES) return { ok: false, issue: "block-too-large" };

  const content = await readExactBlock(canonical, occurrence.start.offset, length);
  if (!content) return { ok: false, issue: "read-failed" };
  return {
    ok: true,
    value: Object.freeze({ path: occurrence.path, contentDigest: digest(content) }),
  };
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

async function readExactBlock(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || offset + length > metadata.size) return undefined;
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = await file.read(buffer, total, length - total, offset + total);
      if (read.bytesRead === 0) return undefined;
      total += read.bytesRead;
    }
    return buffer;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
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
