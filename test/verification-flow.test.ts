import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JscpdCapabilityService } from "../src/capability.js";
import type { JscpdRunRequest, JscpdService } from "../src/jscpd.js";
import { createJscpdScanExecutor } from "../src/scan.js";
import type { JscpdClonePair, JscpdScanReport } from "../src/types.js";
import { createJscpdVerificationService } from "../src/verification.js";
import { type JscpdPromiseRun, jscpdServiceFromPromise } from "./support/jscpd-service.js";

let project: string;
const block = "same";

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "pi-jscpd-verification-flow-"));
  await mkdir(join(project, "src"));
  await Promise.all(
    ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => writeFile(join(project, "src", name), block)),
  );
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function pair(first: string, second: string): JscpdClonePair {
  return {
    format: "typescript",
    lines: 1,
    tokens: 4,
    occurrences: [
      {
        path: `src/${first}`,
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 1, column: 4, offset: 4 },
      },
      {
        path: `src/${second}`,
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 1, column: 4, offset: 4 },
      },
    ],
  };
}

function report(...clonePairs: JscpdClonePair[]): JscpdScanReport {
  const clones = clonePairs.length;
  return {
    clonePairs,
    statistics: {
      formats: [],
      total: {
        lines: 4,
        tokens: 16,
        sources: 4,
        clones,
        duplicatedLines: clones,
        duplicatedTokens: clones * 4,
        percentage: clones * 10,
        percentageTokens: clones * 10,
        newDuplicatedLines: 0,
        newClones: 0,
      },
    },
  };
}

function capability(): JscpdCapabilityService {
  return {
    async probe() {
      return { status: "available", executable: "jscpd", version: "5.1.0", major: 5 };
    },
    invalidate() {},
    dispose() {},
  };
}

function adapter(reports: readonly JscpdScanReport[]): JscpdService {
  let index = 0;
  const run = vi.fn(async (_request: JscpdRunRequest<JscpdScanReport>) => ({
    status: "report",
    value: reports[Math.min(index++, reports.length - 1)],
  })) as unknown as JscpdPromiseRun;
  return jscpdServiceFromPromise(run);
}

describe("explicit scan verification flow", () => {
  it("uses content-aware checkpoints and rolls comparisons forward", async () => {
    const service = adapter([
      report(pair("a.ts", "b.ts")),
      report(pair("a.ts", "b.ts"), pair("c.ts", "d.ts")),
      report(pair("c.ts", "d.ts")),
    ]);
    const executor = createJscpdScanExecutor(capability(), service, {
      config: () => ({ enabled: true, timeoutMs: 1_000, maxFindings: 10 }),
      verification: createJscpdVerificationService(),
    });

    const first = await executor.execute({ command: "scan", args: [] }, { cwd: project });
    const second = await executor.execute({ command: "scan", args: [] }, { cwd: project });
    const third = await executor.execute({ command: "scan", args: [] }, { cwd: project });

    expect(first).toMatchObject({
      status: "completed",
      verification: { state: "checkpoint", groups: 1 },
    });
    expect(second).toMatchObject({
      status: "completed",
      verification: { state: "compared", removed: 0, remaining: 1, created: 1 },
    });
    expect(third).toMatchObject({
      status: "completed",
      verification: { state: "compared", removed: 1, remaining: 1, created: 0 },
    });
    expect("message" in third ? third.message : "").toContain(
      "1 removed, 1 remaining, 0 newly created",
    );
  });

  it("does not compare different explicit target scopes", async () => {
    const executor = createJscpdScanExecutor(
      capability(),
      adapter([report(pair("a.ts", "b.ts")), report(pair("a.ts", "b.ts"))]),
      {
        config: () => ({ enabled: true, timeoutMs: 1_000, maxFindings: 10 }),
        verification: createJscpdVerificationService(),
      },
    );

    await executor.execute({ command: "scan", args: [] }, { cwd: project });
    const scoped = await executor.execute({ command: "scan", args: ["src"] }, { cwd: project });

    expect(scoped).toMatchObject({
      status: "completed",
      verification: { state: "checkpoint", groups: 1 },
    });
  });
});
