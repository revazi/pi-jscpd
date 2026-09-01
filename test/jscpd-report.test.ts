import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeJscpdV5JsonReport,
  JSCPD_STRUCTURED_REPORT_FILE_NAME,
  JSCPD_STRUCTURED_REPORTER,
} from "../src/jscpd-report.js";
import type { JscpdReportErrorCode, JscpdScanReport } from "../src/types.js";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | number | string | null;

const FIXTURE_DIRECTORY = new URL("./fixtures/jscpd-v5/", import.meta.url);
const textEncoder = new TextEncoder();

let root: string;
let projectDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-report-test-"));
  projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixtureBytes(name: string): Promise<Buffer> {
  return readFile(new URL(name, FIXTURE_DIRECTORY));
}

async function fixtureObject(name = "findings.json"): Promise<JsonObject> {
  return asObject(
    JSON.parse(await readFile(new URL(name, FIXTURE_DIRECTORY), "utf8")) as JsonValue,
  );
}

function encode(value: JsonValue): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

async function materialize(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      const target = resolve(projectDirectory, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, `synthetic fixture for ${path}\n`);
    }),
  );
}

async function accepted(bytes: Uint8Array, cwd = projectDirectory): Promise<JscpdScanReport> {
  const decision = await consumeJscpdV5JsonReport(bytes, cwd);
  if (decision.status !== "accepted") {
    const detail = decision.status === "rejected" ? ` (${decision.reason})` : "";
    throw new Error(`Expected an accepted test report, received ${decision.status}${detail}.`);
  }
  return decision.value;
}

async function rejected(bytes: Uint8Array, reason: JscpdReportErrorCode): Promise<void> {
  const decision = await consumeJscpdV5JsonReport(bytes, projectDirectory);
  expect(decision).toEqual({ status: "rejected", reason });
  expect(JSON.stringify(decision).length).toBeLessThan(100);
}

function asObject(value: JsonValue | undefined): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Fixture value is not an object.");
  }
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Fixture value is not an array.");
  }
  return value;
}

function duplicates(report: JsonObject): JsonValue[] {
  return asArray(report.duplicates);
}

function duplicate(report: JsonObject, index = 0): JsonObject {
  return asObject(duplicates(report)[index]);
}

function occurrence(report: JsonObject, name: "firstFile" | "secondFile"): JsonObject {
  return asObject(duplicate(report)[name]);
}

function statistics(report: JsonObject): JsonObject {
  return asObject(report.statistics);
}

function totalStatistics(report: JsonObject): JsonObject {
  return asObject(statistics(report).total);
}

function formatStatistics(report: JsonObject, format = "typescript"): JsonObject {
  return asObject(asObject(statistics(report).formats)[format]);
}

async function mutateFindings(mutate: (report: JsonObject) => void): Promise<Uint8Array> {
  const report = await fixtureObject();
  mutate(report);
  return encode(report);
}

describe("jscpd v5 JSON report normalization", () => {
  it("uses the authoritative JSON reporter contract and fixed filename", () => {
    expect(JSCPD_STRUCTURED_REPORTER).toBe("json");
    expect(JSCPD_STRUCTURED_REPORT_FILE_NAME).toBe("jscpd-report.json");
  });

  it("normalizes a representative v5.1 finding without retaining source fragments", async () => {
    await materialize(["lib/b.ts", "src/a.ts"]);

    const report = await accepted(await fixtureBytes("findings.json"));

    expect(report).toEqual({
      statistics: {
        formats: [
          {
            format: "typescript",
            clones: 1,
            duplicatedLines: 10,
            duplicatedTokens: 66,
            lines: 22,
            newClones: 0,
            newDuplicatedLines: 0,
            percentage: 45.45454545454545,
            percentageTokens: 50,
            sources: 2,
            tokens: 132,
          },
        ],
        total: {
          clones: 1,
          duplicatedLines: 10,
          duplicatedTokens: 66,
          lines: 22,
          newClones: 0,
          newDuplicatedLines: 0,
          percentage: 45.45454545454545,
          percentageTokens: 50,
          sources: 2,
          tokens: 132,
        },
      },
      clonePairs: [
        {
          format: "typescript",
          lines: 11,
          tokens: 66,
          occurrences: [
            {
              path: "lib/b.ts",
              start: { line: 1, column: 0, offset: 0 },
              end: { line: 11, column: 1, offset: 267 },
            },
            {
              path: "src/a.ts",
              start: { line: 1, column: 0, offset: 0 },
              end: { line: 11, column: 1, offset: 267 },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("calculateInvoice");
    expect(JSON.stringify(report)).not.toContain("detectionDate");
    expect(Object.isFrozen(report.clonePairs)).toBe(true);
  });

  it("returns an explicit no-findings decision only for a valid clean report", async () => {
    const clean = await consumeJscpdV5JsonReport(
      await fixtureBytes("clean.json"),
      projectDirectory,
    );
    expect(clean).toMatchObject({ status: "no-findings" });
    if (clean.status === "no-findings") {
      expect(clean.value?.statistics.total.clones).toBe(0);
    }

    const inconsistent = await fixtureObject("clean.json");
    totalStatistics(inconsistent).clones = 1;
    await rejected(encode(inconsistent), "invalid-statistics");
  });

  it("sorts multiple formats and pairs while accepting safe additive v5 fields", async () => {
    await materialize(["python/z.py", "python/a.py", "web/z.ts", "web/a.ts"]);
    const fixture = await fixtureObject("multiple-formats.json");
    fixture.futureTopLevel = { version: 2 };
    duplicate(fixture).futureCloneMetadata = ["safe"];
    occurrence(fixture, "firstFile").blame = { commitSha: "abc", author: "A" };
    totalStatistics(fixture).futureStatistic = 3;

    const report = await accepted(encode(fixture));

    expect(report.statistics.formats.map(({ format }) => format)).toEqual(["python", "typescript"]);
    expect(report.clonePairs.map(({ format }) => format)).toEqual(["python", "typescript"]);
    expect(JSON.stringify(report)).not.toContain("future");
    expect(JSON.stringify(report)).not.toContain("commitSha");
  });

  it("normalizes absolute, relative, and embedded-format source IDs against canonical cwd", async () => {
    await materialize(["lib/b.ts", "src/a.ts"]);
    const fixture = await fixtureObject();
    occurrence(fixture, "firstFile").name = resolve(projectDirectory, "lib/b.ts");
    occurrence(fixture, "secondFile").name = "src/a.ts:typescript";

    const report = await accepted(encode(fixture));

    expect(report.clonePairs[0]?.occurrences.map(({ path }) => path)).toEqual([
      "lib/b.ts",
      "src/a.ts",
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "preserves a real POSIX filename that ends with the clone format",
    async () => {
      await materialize(["lib/b.ts", "src/a.ts:typescript"]);
      const fixture = await fixtureObject();
      occurrence(fixture, "secondFile").name = "src/a.ts:typescript";

      const report = await accepted(encode(fixture));

      expect(report.clonePairs[0]?.occurrences.map(({ path }) => path)).toContain(
        "src/a.ts:typescript",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a format-qualified source ID when literal and embedded paths are distinct files",
    async () => {
      await materialize(["lib/b.ts", "src/a.ts", "src/a.ts:typescript"]);
      const fixture = await fixtureObject();
      occurrence(fixture, "secondFile").name = "src/a.ts:typescript";

      await rejected(encode(fixture), "ambiguous-path");
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts literal and embedded candidates only when they identify the same real file",
    async () => {
      await materialize(["lib/b.ts", "src/a.ts"]);
      await symlink(
        resolve(projectDirectory, "src/a.ts"),
        resolve(projectDirectory, "src/a.ts:typescript"),
      );
      const fixture = await fixtureObject();
      occurrence(fixture, "secondFile").name = "src/a.ts:typescript";

      const report = await accepted(encode(fixture));

      expect(report.clonePairs[0]?.occurrences.map(({ path }) => path)).toContain("src/a.ts");
    },
  );

  it("canonicalizes an in-project symlink and rejects a symlink escape", async () => {
    await materialize(["real/a.ts", "src/a.ts"]);
    await symlink(resolve(projectDirectory, "real/a.ts"), resolve(projectDirectory, "link.ts"));
    const internal = await fixtureObject();
    occurrence(internal, "firstFile").name = "link.ts";
    const normalized = await accepted(encode(internal));
    expect(normalized.clonePairs[0]?.occurrences[0]?.path).toBe("real/a.ts");

    const outside = resolve(root, "outside.ts");
    await writeFile(outside, "synthetic outside fixture\n");
    await symlink(outside, resolve(projectDirectory, "escape.ts"));
    const escaped = await fixtureObject();
    occurrence(escaped, "firstFile").name = "escape.ts";
    await rejected(encode(escaped), "unsafe-path");
  });

  it("produces identical output regardless of reporter collection order", async () => {
    await materialize(["python/z.py", "python/a.py", "web/z.ts", "web/a.ts"]);
    const first = await fixtureObject("multiple-formats.json");
    const second = await fixtureObject("multiple-formats.json");
    second.duplicates = [...duplicates(second)].reverse();
    const originalFormats = asObject(statistics(second).formats);
    statistics(second).formats = Object.fromEntries(
      Object.entries(originalFormats).reverse(),
    ) as JsonObject;

    await expect(accepted(encode(first))).resolves.toEqual(await accepted(encode(second)));
  });

  it("rejects malformed, truncated, empty, and invalid-UTF-8 JSON without body leakage", async () => {
    await rejected(textEncoder.encode("{ private source body"), "malformed-json");
    await rejected(textEncoder.encode('{"duplicates":[]'), "malformed-json");
    await rejected(new Uint8Array(), "malformed-json");
    await rejected(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), "malformed-json");
  });

  it("rejects wrong top-level, duplicate, and statistics shapes", async () => {
    await rejected(textEncoder.encode("[]"), "invalid-top-level");
    await rejected(textEncoder.encode('{"duplicates":{},"statistics":{}}'), "invalid-duplicates");
    await rejected(textEncoder.encode('{"duplicates":[],"statistics":[]}'), "invalid-statistics");

    const missingLocation = await fixtureObject();
    delete occurrence(missingLocation, "firstFile").startLoc;
    await rejected(encode(missingLocation), "invalid-location");

    const missingFragment = await fixtureObject();
    delete duplicate(missingFragment).fragment;
    await rejected(encode(missingFragment), "invalid-duplicates");

    const invalidKnownAdditiveField = await fixtureObject();
    duplicate(invalidKnownAdditiveField).isNew = "false";
    await rejected(encode(invalidKnownAdditiveField), "invalid-duplicates");
  });

  it("classifies v4 JSON and SARIF as unsupported reporter variants", async () => {
    await rejected(
      textEncoder.encode('{"duplicates":[],"statistic":{"total":{}}}'),
      "unsupported-reporter",
    );
    await rejected(
      textEncoder.encode('{"version":"2.1.0","$schema":"sarif","runs":[]}'),
      "unsupported-reporter",
    );
  });

  it("rejects invalid counts and percentages instead of coercing or guessing", async () => {
    const cases: Array<[(report: JsonObject) => void, JscpdReportErrorCode]> = [
      [(report) => (totalStatistics(report).lines = -1), "invalid-statistics"],
      [(report) => (totalStatistics(report).tokens = 1.5), "invalid-statistics"],
      [
        (report) => (totalStatistics(report).sources = Number.MAX_SAFE_INTEGER + 1),
        "invalid-statistics",
      ],
      [(report) => (totalStatistics(report).percentage = 101), "invalid-statistics"],
      [(report) => (duplicate(report).tokens = 0), "invalid-duplicates"],
      [(report) => (duplicate(report).lines = -2), "invalid-duplicates"],
      [(report) => (formatStatistics(report).clones = 0), "invalid-statistics"],
    ];

    for (const [mutate, reason] of cases) {
      await rejected(await mutateFindings(mutate), reason);
    }

    const source = await readFile(new URL("findings.json", FIXTURE_DIRECTORY), "utf8");
    const nonFinite = source.replace('"percentage": 45.45454545454545', '"percentage": 1e400');
    await rejected(textEncoder.encode(nonFinite), "invalid-statistics");
    const negativeZero = source.replace('"percentageTokens": 50.0', '"percentageTokens": -0');
    await rejected(textEncoder.encode(negativeZero), "invalid-statistics");
  });

  it("rejects mismatched and impossible line, column, and offset ranges", async () => {
    const cases: Array<(report: JsonObject) => void> = [
      (report) => (occurrence(report, "firstFile").start = 0),
      (report) => (asObject(occurrence(report, "firstFile").startLoc).line = 2),
      (report) => (occurrence(report, "firstFile").end = 0),
      (report) => (asObject(occurrence(report, "firstFile").endLoc).position = 0),
      (report) => (asObject(occurrence(report, "firstFile").endLoc).position = -1),
      (report) => (duplicate(report).lines = 10),
      (report) => {
        occurrence(report, "secondFile").end = 10;
        const end = asObject(occurrence(report, "secondFile").endLoc);
        end.line = 10;
        end.position = 250;
      },
    ];

    for (const mutate of cases) {
      await rejected(await mutateFindings(mutate), "invalid-location");
    }
  });

  it("rejects zero-width occurrences even when their inclusive line size is positive", async () => {
    const fixture = await fixtureObject();
    for (const name of ["firstFile", "secondFile"] as const) {
      const file = occurrence(fixture, name);
      file.end = file.start;
      file.endLoc = structuredClone(asObject(file.startLoc));
    }
    duplicate(fixture).lines = 1;

    await rejected(encode(fixture), "invalid-location");
  });

  it("rejects traversal, outside, missing, overlong, and foreign-separator paths", async () => {
    await materialize(["lib/b.ts", "src/a.ts"]);
    const outside = resolve(root, "outside.ts");
    await writeFile(outside, "outside synthetic fixture\n");
    const cases: string[] = ["../outside.ts", outside, "missing.ts", `${"x".repeat(4_100)}.ts`];
    if (process.platform !== "win32") {
      cases.push("src\\a.ts");
    }

    for (const path of cases) {
      const fixture = await fixtureObject();
      occurrence(fixture, "firstFile").name = path;
      await rejected(encode(fixture), "unsafe-path");
    }
  });

  it("rejects excessive clone and format collections before resolving occurrence paths", async () => {
    const fixture = await fixtureObject();
    const oneDuplicate = duplicate(fixture);
    fixture.duplicates = Array.from({ length: 1_001 }, () => structuredClone(oneDuplicate));
    totalStatistics(fixture).clones = 1_001;
    formatStatistics(fixture).clones = 1_001;
    await rejected(encode(fixture), "limit-exceeded");

    const tooManyFormats = await fixtureObject("clean.json");
    const emptyRow: JsonObject = {
      lines: 0,
      tokens: 0,
      sources: 0,
      clones: 0,
      duplicatedLines: 0,
      duplicatedTokens: 0,
      percentage: 0,
      percentageTokens: 0,
      newDuplicatedLines: 0,
      newClones: 0,
    };
    statistics(tooManyFormats).formats = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`format-${index}`, emptyRow]),
    ) as JsonObject;
    await rejected(encode(tooManyFormats), "limit-exceeded");
  });

  it("ignores a large bounded fragment and rejects report bytes beyond the parser bound", async () => {
    await materialize(["lib/b.ts", "src/a.ts"]);
    const fixture = await fixtureObject();
    const privateMarker = `private-marker-${"x".repeat(2 * 1_024 * 1_024)}`;
    duplicate(fixture).fragment = privateMarker;

    const report = await accepted(encode(fixture));
    expect(JSON.stringify(report)).not.toContain("private-marker");

    const oversized = textEncoder.encode(`{"ignored":"${"x".repeat(17 * 1_024 * 1_024)}"}`);
    await rejected(oversized, "limit-exceeded");
  });

  it("rejects duplicate JSON keys and orientation-ambiguous clone records", async () => {
    await materialize(["lib/b.ts", "src/a.ts"]);
    const source = await readFile(new URL("findings.json", FIXTURE_DIRECTORY), "utf8");
    const duplicateTopLevelKey = source.replace(
      '"duplicates": [',
      '"duplicates": [], "duplicates": [',
    );
    await rejected(textEncoder.encode(duplicateTopLevelKey), "duplicate-key");
    const escapedDuplicateKey = source.replace('"lines": 22', '"lines": 1, "\\u006cines": 22');
    await rejected(textEncoder.encode(escapedDuplicateKey), "duplicate-key");

    const fixture = await fixtureObject();
    const reversed = structuredClone(duplicate(fixture));
    const first = reversed.firstFile;
    reversed.firstFile = reversed.secondFile;
    reversed.secondFile = first;
    duplicates(fixture).push(reversed);
    totalStatistics(fixture).clones = 2;
    formatStatistics(fixture).clones = 2;

    await rejected(encode(fixture), "ambiguous-duplicate");
  });
});
