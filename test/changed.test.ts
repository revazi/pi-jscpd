import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import type { JscpdBaselineService, JscpdBaselineState } from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import { createJscpdChangedExecutor } from "../src/changed.js";
import { createJscpdChangedFileTracker } from "../src/changed-files.js";
import { indexJscpdCloneReportEffect } from "../src/clone-identity.js";
import { JscpdTestEffectRuntime } from "../src/effect/runtime-boundary.js";
import type { JscpdRunRequest, JscpdRunResult } from "../src/jscpd.js";
import type { JscpdClonePair, JscpdScanReport } from "../src/types.js";
import { createJscpdVerificationService } from "../src/verification.js";
import { type JscpdPromiseRun, jscpdServiceFromPromise } from "./support/jscpd-service.js";

let root: string;
let project: string;
const oldBlock = "const shared = 1;\n";
const newBlock = "const shared = 2;\n";
const thirdBlock = "const shared = 3;\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-changed-test-"));
  project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(project, "src", "a.ts"), oldBlock),
    writeFile(join(project, "src", "b.ts"), oldBlock),
    writeFile(join(project, "src", "c.ts"), newBlock),
    writeFile(join(project, "src", "d.ts"), newBlock),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clone(first: string, second: string, block = oldBlock): JscpdClonePair {
  const length = Buffer.byteLength(block);
  return {
    format: "typescript",
    lines: 1,
    tokens: 5,
    occurrences: [
      {
        path: first,
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 1, column: length, offset: length },
      },
      {
        path: second,
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 1, column: length, offset: length },
      },
    ],
  };
}

function report(...clonePairs: JscpdClonePair[]): JscpdScanReport {
  const count = clonePairs.length;
  const row = {
    lines: count * 2,
    tokens: count * 10,
    sources: count ? 3 : 0,
    clones: count,
    duplicatedLines: count,
    duplicatedTokens: count * 5,
    percentage: count ? 20 : 0,
    percentageTokens: count ? 20 : 0,
    newDuplicatedLines: 0,
    newClones: 0,
  };
  return { statistics: { total: row, formats: [] }, clonePairs };
}

async function acceptedBaseline(): Promise<JscpdBaselineState> {
  const baselineReport = report(clone("src/a.ts", "src/b.ts"));
  return {
    status: "accepted",
    outcome: "findings",
    report: baselineReport,
    snapshot: await JscpdTestEffectRuntime.runPromise(
      indexJscpdCloneReportEffect(baselineReport, project),
    ),
  };
}

function baseline(state: JscpdBaselineState): JscpdBaselineService {
  return {
    async start() {
      return state;
    },
    async wait() {
      return state;
    },
    disable() {},
    invalidate() {},
    current() {
      return state;
    },
  };
}

function capability(): JscpdCapabilityService {
  return {
    async probe() {
      return { status: "available", executable: "jscpd", version: "5.1.1", major: 5 };
    },
    invalidate() {},
    dispose() {},
  };
}

function adapter(results: readonly JscpdRunResult<JscpdScanReport>[]) {
  let index = 0;
  const runMock = vi.fn(
    async (_request: JscpdRunRequest<JscpdScanReport>) =>
      results[Math.min(index++, results.length - 1)],
  );
  const run = runMock as unknown as JscpdPromiseRun;
  return {
    service: jscpdServiceFromPromise(run),
    run: runMock,
  };
}

async function setup(results: readonly JscpdRunResult<JscpdScanReport>[]) {
  const tracker = createJscpdChangedFileTracker();
  await tracker.start(project, ["src/a.ts"]);
  const acknowledgements = createJscpdAcknowledgementTracker();
  const scan = adapter(results);
  const stateChanged = vi.fn();
  const executor = createJscpdChangedExecutor(
    capability(),
    scan.service,
    baseline(await acceptedBaseline()),
    tracker,
    acknowledgements,
    { config: () => ({ enabled: true, timeoutMs: 1234, maxFindings: 10 }), stateChanged },
  );
  return { executor, acknowledgements, scan, stateChanged };
}

describe("/jscpd changed", () => {
  it("returns a clean bounded result without scanning when no session files are tracked", async () => {
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);
    const scan = adapter([{ status: "report", value: report() }]);
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(await acceptedBaseline()),
      tracker,
      createJscpdAcknowledgementTracker(),
    );

    await expect(
      executor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({
      status: "changed",
      outcome: "clean",
      scanPerformed: false,
      findings: [],
    });
    expect(scan.run).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "unavailable", reason: "missing-binary" } as const, "baseline-unavailable"],
    [{ status: "cancelled", stage: "scan" } as const, "baseline-cancelled"],
    [{ status: "timed-out", stage: "scan", timeoutMs: 50 } as const, "baseline-timed-out"],
    [{ status: "failed", stage: "scan", reason: "missing-report" } as const, "baseline-failed"],
  ])("fails open for baseline state %# without starting a current scan", async (state, reason) => {
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/a.ts"]);
    const scan = adapter([{ status: "report", value: report() }]);
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(state),
      tracker,
      createJscpdAcknowledgementTracker(),
    );

    await expect(
      executor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({ status: "changed-unavailable", reason });
    expect(scan.run).not.toHaveBeenCalled();
  });

  it("surfaces only net-new groups involving tracked files and acknowledges repeated checks", async () => {
    const baselineState = await acceptedBaseline();
    await writeFile(join(project, "src", "a.ts"), newBlock);
    const unrelated = clone("src/b.ts", "src/b.ts");
    const added = clone("src/a.ts", "src/c.ts", newBlock);
    const current = report(unrelated, added);
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/a.ts"]);
    const acknowledgements = createJscpdAcknowledgementTracker();
    const scan = adapter([
      { status: "report", value: current },
      { status: "report", value: current },
    ]);
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(baselineState),
      tracker,
      acknowledgements,
      { config: () => ({ enabled: true, timeoutMs: 1234, maxFindings: 10 }) },
    );

    const first = await executor.execute({ command: "changed", args: [] }, { cwd: project });
    const repeated = await executor.execute({ command: "changed", args: [] }, { cwd: project });

    expect(first).toMatchObject({
      status: "changed",
      outcome: "findings",
      scanPerformed: true,
      findings: [
        {
          occurrences: [
            { path: "src/a.ts", relation: "new-session" },
            { path: "src/c.ts", relation: "existing-match" },
          ],
        },
      ],
    });
    expect(first.message).toContain("new in this session: src/a.ts:1-1");
    expect(first.message).toContain("existing match: src/c.ts:1-1");
    expect(repeated).toMatchObject({ status: "changed", outcome: "clean", findings: [] });
    expect(acknowledgements.findings()).toHaveLength(1);
    const request = scan.run.mock.calls[0]?.[0];
    expect(request).toMatchObject({ timeoutMs: 1234, cwd: await realpath(project) });
    expect(
      request?.createArguments({ directory: "/tmp/report", reportPath: "/tmp/report/file" }),
    ).toEqual(["--reporters", "json", "--output", "/tmp/report", "--absolute", "--", "."]);
  });

  it("prioritizes two changed locations before larger one-sided candidates and leaves omissions unacknowledged", async () => {
    await Promise.all([
      writeFile(join(project, "src", "e.ts"), thirdBlock),
      writeFile(join(project, "src", "f.ts"), thirdBlock),
    ]);
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/c.ts", "src/d.ts", "src/e.ts"]);
    const current = report(
      clone("src/a.ts", "src/b.ts"),
      { ...clone("src/e.ts", "src/f.ts", thirdBlock), lines: 20, tokens: 100 },
      clone("src/c.ts", "src/d.ts", newBlock),
    );
    const scan = adapter([{ status: "report", value: current }]);
    const acknowledgements = createJscpdAcknowledgementTracker();
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(await acceptedBaseline()),
      tracker,
      acknowledgements,
      {
        config: () => ({ enabled: true, timeoutMs: 1234, maxFindings: 1 }),
        prioritizeFindings: true,
      },
    );

    const first = await executor.execute({ command: "changed", args: [] }, { cwd: project });
    const second = await executor.execute({ command: "changed", args: [] }, { cwd: project });

    expect(first).toMatchObject({
      status: "changed",
      outcome: "findings",
      omittedFindings: 1,
      findings: [
        {
          occurrences: [
            { path: "src/c.ts", relation: "new-session" },
            { path: "src/d.ts", relation: "new-session" },
          ],
        },
      ],
    });
    expect(second).toMatchObject({
      status: "changed",
      outcome: "findings",
      omittedFindings: 0,
      findings: [
        {
          occurrences: [
            { path: "src/e.ts", relation: "new-session" },
            { path: "src/f.ts", relation: "existing-match" },
          ],
        },
      ],
    });
  });

  it("acknowledges only displayed findings when the presentation cap omits another", async () => {
    await writeFile(join(project, "src", "a.ts"), newBlock);
    const current = report(
      clone("src/a.ts", "src/c.ts", newBlock),
      clone("src/a.ts", "src/d.ts", newBlock),
    );
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/a.ts"]);
    const acknowledgements = createJscpdAcknowledgementTracker();
    const scan = adapter([
      { status: "report", value: current },
      { status: "report", value: current },
    ]);
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(await acceptedBaseline()),
      tracker,
      acknowledgements,
      { config: () => ({ enabled: true, timeoutMs: 1234, maxFindings: 1 }) },
    );

    const first = await executor.execute({ command: "changed", args: [] }, { cwd: project });
    const second = await executor.execute({ command: "changed", args: [] }, { cwd: project });

    expect(first).toMatchObject({ outcome: "findings", omittedFindings: 1 });
    expect(first.message).toContain("not acknowledged");
    expect(second).toMatchObject({ outcome: "findings", omittedFindings: 0 });
    expect(acknowledgements.findings()).toHaveLength(2);
  });

  it("does not suppress a materially changed finding", async () => {
    await writeFile(join(project, "src", "a.ts"), newBlock);
    const firstReport = report(clone("src/a.ts", "src/c.ts", newBlock));
    const setupState = await setup([
      { status: "report", value: firstReport },
      { status: "report", value: report(clone("src/a.ts", "src/c.ts", thirdBlock)) },
    ]);
    await expect(
      setupState.executor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({ outcome: "findings" });

    await Promise.all([
      writeFile(join(project, "src", "a.ts"), thirdBlock),
      writeFile(join(project, "src", "c.ts"), thirdBlock),
    ]);
    await expect(
      setupState.executor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({ outcome: "findings" });
  });

  it("surfaces a removed-then-reintroduced finding again", async () => {
    await writeFile(join(project, "src", "a.ts"), newBlock);
    const findingReport = report(clone("src/a.ts", "src/c.ts", newBlock));
    const setupState = await setup([
      { status: "report", value: findingReport },
      { status: "no-findings", value: report() },
      { status: "report", value: findingReport },
    ]);

    const outcomes = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await setupState.executor.execute(
        { command: "changed", args: [] },
        { cwd: project },
      );
      outcomes.push(result.status === "changed" ? result.outcome : result.status);
    }
    expect(outcomes).toEqual(["findings", "clean", "findings"]);
  });

  it("verifies removed and remaining groups even after the first changed finding is acknowledged", async () => {
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/a.ts"]);
    const scan = adapter([
      {
        status: "report",
        value: report(clone("src/a.ts", "src/b.ts"), clone("src/a.ts", "src/c.ts", oldBlock)),
      },
      { status: "report", value: report(clone("src/a.ts", "src/b.ts")) },
    ]);
    const executor = createJscpdChangedExecutor(
      capability(),
      scan.service,
      baseline(await acceptedBaseline()),
      tracker,
      createJscpdAcknowledgementTracker(),
      {
        config: () => ({ enabled: true, timeoutMs: 1_000, maxFindings: 10 }),
        verification: createJscpdVerificationService(),
      },
    );

    const first = await executor.execute({ command: "changed", args: [] }, { cwd: project });
    const second = await executor.execute({ command: "changed", args: [] }, { cwd: project });

    expect(first).toMatchObject({
      status: "changed",
      outcome: "findings",
      verification: { state: "checkpoint", groups: 2 },
    });
    expect(second).toMatchObject({
      status: "changed",
      outcome: "clean",
      verification: { state: "compared", removed: 1, remaining: 1, created: 0 },
    });
  });

  it("fails open without changing acknowledgements for partial baselines, identities, and failed scans", async () => {
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/a.ts"]);
    const acknowledgements = createJscpdAcknowledgementTracker();
    const partialExecutor = createJscpdChangedExecutor(
      capability(),
      adapter([{ status: "report", value: report() }]).service,
      baseline({ status: "partial", reason: "restored-after-changes" }),
      tracker,
      acknowledgements,
    );
    await expect(
      partialExecutor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({ status: "changed-unavailable", reason: "baseline-partial" });

    const identitySetup = await setup([
      { status: "report", value: report(clone("src/a.ts", "src/missing.ts")) },
    ]);
    await expect(
      identitySetup.executor.execute({ command: "changed", args: [] }, { cwd: project }),
    ).resolves.toMatchObject({ status: "changed-unavailable", reason: "identity-partial" });
    expect(identitySetup.acknowledgements.findings()).toEqual([]);

    for (const [runResult, reason] of [
      [{ status: "timed-out", timeoutMs: 50 } as const, "scan-timed-out"],
      [{ status: "cancelled" } as const, "scan-cancelled"],
      [{ status: "failed", reason: "spawn-failed" } as const, "process-failed"],
    ] as const) {
      const failedSetup = await setup([runResult]);
      await expect(
        failedSetup.executor.execute({ command: "changed", args: [] }, { cwd: project }),
      ).resolves.toMatchObject({ status: "failed", reason });
      expect(failedSetup.acknowledgements.findings()).toEqual([]);
      expect(failedSetup.stateChanged).not.toHaveBeenCalled();
    }
  });
});
