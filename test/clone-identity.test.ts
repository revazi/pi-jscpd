import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareJscpdCloneSnapshots, indexJscpdCloneReportEffect } from "../src/clone-identity.js";
import type { JscpdCloneOccurrence, JscpdClonePair, JscpdScanReport } from "../src/types.js";
import { JscpdTestEffectRuntime } from "./support/runtime.js";

let root: string;
let project: string;
const block = "const shared = 1;\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-identity-test-"));
  project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(project, "src", "a.ts"), block),
    writeFile(join(project, "src", "b.ts"), block),
    writeFile(join(project, "src", "c.ts"), block),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function occurrence(
  path: string,
  offset = 0,
  line = 1,
  length = Buffer.byteLength(block),
): JscpdCloneOccurrence {
  return {
    path,
    start: { line, column: 0, offset },
    end: { line, column: length, offset: offset + length },
  };
}

function clone(first: JscpdCloneOccurrence, second: JscpdCloneOccurrence): JscpdClonePair {
  return {
    format: "typescript",
    lines: 1,
    tokens: 5,
    occurrences: [first, second],
  };
}

function report(...clonePairs: JscpdClonePair[]): JscpdScanReport {
  const count = clonePairs.length;
  const row = {
    lines: count * 2,
    tokens: count * 10,
    sources: count ? 2 : 0,
    clones: count,
    duplicatedLines: count,
    duplicatedTokens: count * 5,
    percentage: count ? 50 : 0,
    percentageTokens: count ? 50 : 0,
    newDuplicatedLines: 0,
    newClones: 0,
  };
  return { statistics: { total: row, formats: [] }, clonePairs };
}

describe("stable clone identity and baseline comparison", () => {
  it("treats reordered occurrences and ordinary line movement as existing", async () => {
    const baselineReport = report(clone(occurrence("src/a.ts"), occurrence("src/b.ts")));
    const baseline = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(baselineReport, project),
    );
    const prefix = "// inserted before clone\n";
    await Promise.all([
      writeFile(join(project, "src", "a.ts"), prefix + block),
      writeFile(join(project, "src", "b.ts"), prefix + block),
    ]);
    const movedOffset = Buffer.byteLength(prefix);
    const currentReport = report(
      clone(occurrence("src/b.ts", movedOffset, 2), occurrence("src/a.ts", movedOffset, 2)),
    );
    const current = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(currentReport, project),
    );

    const comparison = compareJscpdCloneSnapshots(baseline, current);

    expect(baseline.status).toBe("accepted");
    expect(current.status).toBe("accepted");
    expect(baseline.groups[0]?.occurrenceFingerprints).toEqual(
      [...(current.groups[0]?.occurrenceFingerprints ?? [])].reverse(),
    );
    expect(baseline.groups[0]?.fingerprint).toBe(current.groups[0]?.fingerprint);
    expect(comparison).toMatchObject({
      existing: [currentReport.clonePairs[0]],
      new: [],
      removed: [],
      ambiguous: [],
    });
  });

  it("classifies changed block content as one removed and one new group", async () => {
    const baselineReport = report(clone(occurrence("src/a.ts"), occurrence("src/b.ts")));
    const baseline = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(baselineReport, project),
    );
    const changed = "const shared = 2;\n";
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(block));
    await Promise.all([
      writeFile(join(project, "src", "a.ts"), changed),
      writeFile(join(project, "src", "b.ts"), changed),
    ]);
    const currentReport = report(clone(occurrence("src/a.ts"), occurrence("src/b.ts")));
    const current = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(currentReport, project),
    );

    expect(compareJscpdCloneSnapshots(baseline, current)).toMatchObject({
      existing: [],
      new: [currentReport.clonePairs[0]],
      removed: [baselineReport.clonePairs[0]],
      ambiguous: [],
    });
  });

  it("classifies path-pair additions and removals deterministically", async () => {
    const removedGroup = clone(occurrence("src/a.ts"), occurrence("src/b.ts"));
    const addedGroup = clone(occurrence("src/a.ts"), occurrence("src/c.ts"));
    const baseline = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(removedGroup), project),
    );
    const current = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(addedGroup), project),
    );

    expect(compareJscpdCloneSnapshots(baseline, current)).toMatchObject({
      existing: [],
      new: [addedGroup],
      removed: [removedGroup],
      ambiguous: [],
    });
  });

  it("keeps repeated indistinguishable groups ambiguous instead of matching by order", async () => {
    const pair = clone(occurrence("src/a.ts"), occurrence("src/b.ts"));
    const baseline = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(pair, pair), project),
    );
    const current = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(pair, pair), project),
    );

    const comparison = compareJscpdCloneSnapshots(baseline, current);

    expect(comparison.existing).toEqual([]);
    expect(comparison.new).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(comparison.ambiguous).toEqual([
      { reason: "non-unique-identity", baseline: [pair, pair], current: [pair, pair] },
    ]);
  });

  it("marks missing source content partial and does not claim a removal", async () => {
    const pair = clone(occurrence("src/a.ts"), occurrence("src/b.ts"));
    const baseline = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(pair), project),
    );
    const missingPair = clone(occurrence("src/a.ts"), occurrence("src/missing.ts"));
    const current = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(missingPair), project),
    );

    expect(current).toMatchObject({
      status: "partial",
      groups: [{ issue: "missing-source" }],
    });
    const comparison = compareJscpdCloneSnapshots(baseline, current);
    expect(comparison.removed).toEqual([]);
    expect(comparison.ambiguous).toHaveLength(2);
    expect(comparison.ambiguous.every(({ reason }) => reason === "identity-unavailable")).toBe(
      true,
    );
  });

  it("handles malformed and partial runtime inputs without throwing or reviving identity", async () => {
    const malformed = { statistics: {}, clonePairs: null } as unknown as JscpdScanReport;
    const malformedSnapshot = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(malformed, project),
    );
    const unsafePair = clone(occurrence("../outside.ts"), occurrence("src/b.ts"));
    const partialSnapshot = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(unsafePair), project),
    );

    expect(malformedSnapshot).toEqual({ status: "partial", groups: [], omittedGroups: 0 });
    expect(partialSnapshot).toMatchObject({
      status: "partial",
      groups: [{ issue: "unsafe-path" }],
    });
    expect(
      compareJscpdCloneSnapshots(malformedSnapshot, partialSnapshot).ambiguous.length,
    ).toBeGreaterThan(0);
  });

  it("rejects oversized or invalid byte spans as partial identity evidence", async () => {
    const zeroLength = occurrence("src/a.ts", 0, 1, 0);
    const oversized = occurrence("src/b.ts", 0, 1, 1024 * 1024 + 1);
    const snapshot = await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(report(clone(zeroLength, oversized)), project),
    );

    expect(snapshot).toMatchObject({
      status: "partial",
      groups: [{ issue: "invalid-range" }],
    });
  });
});
