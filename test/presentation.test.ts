import { describe, expect, it } from "vitest";
import { presentJscpdChanged, presentJscpdScan } from "../src/presentation.js";
import type { JscpdClonePair, JscpdScanReport } from "../src/types.js";

function statisticsRow(clones: number) {
  return {
    clones,
    duplicatedLines: clones * 5,
    duplicatedTokens: clones * 20,
    lines: 200,
    newClones: 0,
    newDuplicatedLines: 0,
    percentage: 25,
    percentageTokens: 20,
    sources: 24,
    tokens: 1_000,
  };
}

function clonePair(index: number, path: string): JscpdClonePair {
  return {
    format: "typescript",
    lines: 5,
    tokens: 20,
    occurrences: [
      {
        path: `${path}/first-${index}.ts`,
        start: { line: 10, column: 0, offset: 100 },
        end: { line: 14, column: 1, offset: 200 },
      },
      {
        path: `${path}/second-${index}.ts`,
        start: { line: 30, column: 0, offset: 300 },
        end: { line: 34, column: 1, offset: 400 },
      },
    ],
  };
}

describe("bounded changed presentation", () => {
  it("labels session-owned and existing-match locations and leaves omitted findings unacknowledged", () => {
    const pairs = [clonePair(1, "src"), clonePair(2, "src")];
    const changed = new Set(["src/first-1.ts", "src/first-2.ts"]);

    const result = presentJscpdChanged(pairs, changed, 1, 1);

    expect(result).toMatchObject({
      status: "changed",
      outcome: "findings",
      scanPerformed: true,
      omittedFindings: 1,
      ambiguousFindings: 1,
      findings: [
        {
          occurrences: [
            { relation: "new-session", path: "src/first-1.ts" },
            { relation: "existing-match", path: "src/second-1.ts" },
          ],
        },
      ],
    });
    expect(result.message).toContain("new in this session");
    expect(result.message).toContain("existing match");
    expect(result.message).toContain("not acknowledged");
    expect(result.message).toContain("could not be classified conservatively");
    expect(result.message).toContain("refactor through the normal agent flow");
    expect(result.message).toContain("jscpd ignore/exclusion configuration");
  });
});

describe("bounded scan presentation", () => {
  it("caps findings and path display while retaining both locations and summary statistics", () => {
    const longPath = `src/${"nested/".repeat(100)}`;
    const clonePairs = Array.from({ length: 12 }, (_, index) => clonePair(index, longPath));
    const report: JscpdScanReport = {
      clonePairs,
      statistics: {
        formats: [{ format: "typescript", ...statisticsRow(12) }],
        total: statisticsRow(12),
      },
    };

    const presented = presentJscpdScan(report);

    expect(presented).toMatchObject({
      status: "completed",
      outcome: "findings",
      omittedFindings: 2,
      summary: {
        clones: 12,
        duplicatedLines: 60,
        duplicatedTokens: 240,
        percentage: 25,
        sources: 24,
      },
    });
    expect(presented.findings).toHaveLength(10);
    expect(presented.findings[0]?.occurrences).toHaveLength(2);
    expect(presented.findings[0]?.occurrences.every(({ path }) => path.length <= 240)).toBe(true);
    expect(presented.message).toContain("12 duplicate blocks");
    expect(presented.message).toContain("2 additional duplicate blocks omitted");
    expect(presented.message).toContain(
      "full-project scan reports two current locations; it does not determine which location is new",
    );
    expect(presented.message).toContain("Duplication may be intentional");
    expect(presented.message).toContain("jscpd ignore/exclusion configuration");
    expect(presented.message.length).toBeLessThan(8_000);
    expect(presented.terminalMessage).toBe(presented.message);

    const configured = presentJscpdScan(report, 3);
    expect(configured.findings).toHaveLength(3);
    expect(configured.omittedFindings).toBe(9);
  });

  it("renders stable ordered and empty consumer-facing snapshots without source fragments", () => {
    const report: JscpdScanReport = {
      clonePairs: [clonePair(1, "src")],
      statistics: {
        formats: [{ format: "typescript", ...statisticsRow(1) }],
        total: statisticsRow(1),
      },
    };
    const finding = presentJscpdScan(report);
    const clean = presentJscpdScan({
      clonePairs: [],
      statistics: {
        formats: [],
        total: statisticsRow(0),
      },
    });
    const changedEmpty = presentJscpdChanged([], new Set());

    expect(finding.message).toMatchInlineSnapshot(`
      "jscpd found 1 duplicate block: 5 duplicated lines (25%) and 20 duplicated tokens (20%) across 24 sources.
      Duplicate block 1 of 1
      current location: src/first-1.ts:10-14
      current location: src/second-1.ts:30-34
      5 lines | 20 tokens | typescript
      A full-project scan reports two current locations; it does not determine which location is new.
      Duplication may be intentional; inspect both locations and surrounding behavior before changing code.
      If shared behavior should stay synchronized, refactor through the normal agent flow, run relevant tests, then rescan.
      If the duplication is intentional, keep it or update existing jscpd ignore/exclusion configuration through the normal agent flow."
    `);
    expect(clean.message).toMatchInlineSnapshot(
      `"jscpd scan clean: 0 duplicate blocks across 200 lines and 1000 tokens in 24 sources."`,
    );
    expect(changedEmpty.message).toMatchInlineSnapshot(
      `"jscpd changed: no unacknowledged new duplicate blocks involve session-owned changed files."`,
    );
    expect(finding.message.indexOf("src/first-1.ts")).toBeLessThan(
      finding.message.indexOf("src/second-1.ts"),
    );
    expect(finding.message).not.toContain("source fragment marker");
    expect(finding.terminalMessage).toBe(finding.message);
  });
});
