import { describe, expect, it } from "vitest";
import { presentJscpdScan } from "../src/presentation.js";
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
    expect(presented.message.length).toBeLessThan(8_000);
    expect(presented.terminalMessage).toBe(presented.message);

    const configured = presentJscpdScan(report, 3);
    expect(configured.findings).toHaveLength(3);
    expect(configured.omittedFindings).toBe(9);
  });
});
