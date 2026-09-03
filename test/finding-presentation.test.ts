import { describe, expect, it } from "vitest";
import {
  boundedJscpdDisplayPath,
  jscpdFindingDetailLines,
  jscpdFindingGuidance,
  jscpdFindingLocations,
  jscpdFindingMetadata,
} from "../src/finding-presentation.js";
import type { JscpdChangedFinding, JscpdPresentedFinding } from "../src/types.js";

const changedFinding: JscpdChangedFinding = {
  format: "typescript",
  lines: 17,
  tokens: 91,
  occurrences: [
    {
      path: "src/new.ts",
      startLine: 12,
      endLine: 28,
      relation: "new-session",
    },
    {
      path: "src/existing.ts",
      startLine: 44,
      endLine: 60,
      relation: "existing-match",
    },
  ],
};

const projectFinding: JscpdPresentedFinding = {
  format: "python",
  lines: 9,
  tokens: 42,
  occurrences: [
    { path: "app/alpha.py", startLine: 3, endLine: 11 },
    { path: "app/beta.py", startLine: 20, endLine: 28 },
  ],
};

describe("shared finding presentation", () => {
  it("describes changed locations, spans, size, format, and total consistently", () => {
    expect(jscpdFindingDetailLines(changedFinding, 1, 3)).toMatchInlineSnapshot(`
      [
        "Duplicate block 1 of 3",
        "new in this session: src/new.ts:12-28",
        "existing match: src/existing.ts:44-60",
        "17 lines | 91 tokens | typescript",
      ]
    `);
    expect(jscpdFindingLocations(changedFinding)).toEqual([
      { label: "new in this session", text: "src/new.ts:12-28" },
      { label: "existing match", text: "src/existing.ts:44-60" },
    ]);
    expect(jscpdFindingMetadata(changedFinding)).toBe("17 lines | 91 tokens | typescript");
  });

  it("does not invent a new/existing relation for project scan findings", () => {
    expect(jscpdFindingDetailLines(projectFinding, 2, 4)).toMatchInlineSnapshot(`
      [
        "Duplicate block 2 of 4",
        "current location: app/alpha.py:3-11",
        "current location: app/beta.py:20-28",
        "9 lines | 42 tokens | python",
      ]
    `);
    expect(jscpdFindingGuidance("project")).toMatchInlineSnapshot(`
      [
        "A full-project scan reports two current locations; it does not determine which location is new.",
        "Duplication may be intentional; inspect both locations and surrounding behavior before changing code.",
        "If shared behavior should stay synchronized, refactor through the normal agent flow, run relevant tests, then rescan.",
        "If the duplication is intentional, keep it or update existing jscpd ignore/exclusion configuration through the normal agent flow.",
      ]
    `);
  });

  it("states conservative changed classification and inspect/refactor/configure options", () => {
    expect(jscpdFindingGuidance("changed")).toMatchInlineSnapshot(`
      [
        "“new in this session” marks a tracked changed file; “existing match” marks the other current location.",
        "Duplication may be intentional; inspect both locations and surrounding behavior before changing code.",
        "If shared behavior should stay synchronized, refactor through the normal agent flow, run relevant tests, then rescan.",
        "If the duplication is intentional, keep it or update existing jscpd ignore/exclusion configuration through the normal agent flow.",
      ]
    `);
  });

  it("middle-ellipsizes Unicode paths at 240 code points without adding source text", () => {
    const path = `src/${"😀".repeat(300)}/file.ts`;
    const bounded = boundedJscpdDisplayPath(path);

    expect(Array.from(bounded)).toHaveLength(240);
    expect(bounded).toContain("…");
    expect(bounded.startsWith("src/😀")).toBe(true);
    expect(bounded.endsWith("/file.ts")).toBe(true);
    expect(bounded).not.toContain("source fragment marker");
  });
});
