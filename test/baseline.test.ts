import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJscpdBaselineService, type JscpdBaselineStartContext } from "../src/baseline.js";
import type { JscpdCapabilityResult, JscpdCapabilityService } from "../src/capability.js";
import type { JscpdRunRequest, JscpdRunResult, JscpdService } from "../src/jscpd.js";
import type { JscpdScanReport } from "../src/types.js";

let root: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-baseline-test-"));
  project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "lib"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const available: JscpdCapabilityResult = {
  status: "available",
  executable: "jscpd",
  version: "5.1.1",
  major: 5,
};

function context(overrides: Partial<JscpdBaselineStartContext> = {}): JscpdBaselineStartContext {
  return {
    cwd: project,
    enabled: true,
    timeoutMs: 1234,
    hasPriorChanges: false,
    ...overrides,
  };
}

function capability(result: JscpdCapabilityResult = available) {
  const probe = vi.fn<JscpdCapabilityService["probe"]>(async () => result);
  return {
    service: { probe, invalidate() {}, dispose() {} } satisfies JscpdCapabilityService,
    probe,
  };
}

function adapter(result: JscpdRunResult<JscpdScanReport>) {
  const runMock = vi.fn(async (_request: JscpdRunRequest<JscpdScanReport>) => result);
  const run = runMock as unknown as JscpdService["run"];
  return {
    service: { run, invalidate() {}, async dispose() {} } satisfies JscpdService,
    run: runMock,
  };
}

function report(clones: number): JscpdScanReport {
  const row = {
    lines: clones ? 2 : 0,
    tokens: clones ? 8 : 0,
    sources: clones ? 2 : 0,
    clones,
    duplicatedLines: clones,
    duplicatedTokens: clones * 4,
    percentage: clones ? 50 : 0,
    percentageTokens: clones ? 50 : 0,
    newDuplicatedLines: 0,
    newClones: 0,
  };
  return {
    statistics: { total: row, formats: [] },
    clonePairs: clones
      ? [
          {
            format: "typescript",
            lines: 1,
            tokens: 4,
            occurrences: [
              {
                path: "lib/b.ts",
                start: { line: 1, column: 0, offset: 0 },
                end: { line: 1, column: 1, offset: 1 },
              },
              {
                path: "src/a.ts",
                start: { line: 1, column: 0, offset: 0 },
                end: { line: 1, column: 1, offset: 1 },
              },
            ],
          },
        ]
      : [],
  };
}

describe("initial jscpd baseline", () => {
  it.each([
    ["clean", { status: "no-findings", value: report(0) } as const],
    ["findings", { status: "report", value: report(1) } as const],
  ])("accepts a normalized %s baseline in memory", async (outcome, runResult) => {
    const cap = capability();
    const scan = adapter(runResult);
    const service = createJscpdBaselineService(cap.service, scan.service, { path: "/test/bin" });

    const captured = await service.start(context());

    expect(captured).toMatchObject({ status: "accepted", outcome });
    expect(service.current()).toBe(captured);
    const canonicalProject = await realpath(project);
    expect(cap.probe).toHaveBeenCalledWith({
      cwd: canonicalProject,
      path: "/test/bin",
      signal: expect.any(AbortSignal),
    });
    const request = scan.run.mock.calls[0]?.[0] as JscpdRunRequest<JscpdScanReport>;
    expect(request).toMatchObject({
      executable: "jscpd",
      cwd: canonicalProject,
      timeoutMs: 1234,
    });
    expect(
      request.createArguments({ directory: "/tmp/report", reportPath: "/tmp/report/file" }),
    ).toEqual(["--reporters", "json", "--output", "/tmp/report", "--absolute", "--", "."]);
    expect(request.reportExitCodes).toEqual([1]);
  });

  it("passes strict report consumption to the adapter", async () => {
    await writeFile(join(project, "src", "a.ts"), "x".repeat(300));
    await writeFile(join(project, "lib", "b.ts"), "x".repeat(300));
    const bytes = await readFile(join(process.cwd(), "test/fixtures/jscpd-v5/findings.json"));
    const cap = capability();
    const run = vi.fn(async (request: JscpdRunRequest<JscpdScanReport>) => {
      const decision = await request.consumeReport(bytes);
      return decision.status === "accepted"
        ? ({ status: "report", value: decision.value } as const)
        : ({ status: "failed", reason: "invalid-report" } as const);
    }) as unknown as JscpdService["run"];
    const service = createJscpdBaselineService(cap.service, {
      run,
      invalidate() {},
      async dispose() {},
    });

    await expect(service.start(context())).resolves.toMatchObject({
      status: "accepted",
      outcome: "findings",
      report: { clonePairs: [{ occurrences: [{ path: "lib/b.ts" }, { path: "src/a.ts" }] }] },
      snapshot: { status: "accepted", groups: [{ fingerprint: expect.any(String) }] },
    });
  });

  it.each([
    [
      { status: "missing", checked: ["jscpd", "cpd"] } as const,
      { status: "unavailable", reason: "missing-binary" },
    ],
    [
      {
        status: "incompatible",
        executable: "jscpd",
        version: "4.0.0",
        major: 4,
        supportedMajor: 5,
      } as const,
      { status: "unavailable", reason: "incompatible-version" },
    ],
    [
      { status: "cancelled", executable: "jscpd" } as const,
      { status: "cancelled", stage: "probe" },
    ],
    [
      { status: "timed-out", executable: "jscpd", timeoutMs: 2000 } as const,
      { status: "timed-out", stage: "probe", timeoutMs: 2000 },
    ],
    [
      { status: "failed", executable: "jscpd", reason: "execution-error" } as const,
      { status: "failed", stage: "probe", reason: "execution-error" },
    ],
  ] as const)("represents capability outcome %#", async (probeResult, expected) => {
    const cap = capability(probeResult);
    const scan = adapter({ status: "report", value: report(1) });
    const service = createJscpdBaselineService(cap.service, scan.service);

    await expect(service.start(context())).resolves.toMatchObject(expected);
    expect(scan.run).not.toHaveBeenCalled();
  });

  it.each([
    [
      { status: "timed-out", timeoutMs: 50 } as const,
      { status: "timed-out", stage: "scan", timeoutMs: 50 },
    ],
    [{ status: "cancelled" } as const, { status: "cancelled", stage: "scan" }],
    [{ status: "invalidated" } as const, { status: "cancelled", stage: "lifecycle" }],
    [
      { status: "no-report" } as const,
      { status: "failed", stage: "scan", reason: "missing-report" },
    ],
    [
      { status: "failed", reason: "invalid-report", reportError: "malformed-json" } as const,
      { status: "failed", stage: "scan", reason: "invalid-report", reportError: "malformed-json" },
    ],
  ] as const)("represents adapter outcome %#", async (runResult, expected) => {
    const scan = adapter(runResult);
    const service = createJscpdBaselineService(capability().service, scan.service);

    await expect(service.start(context())).resolves.toMatchObject(expected);
  });

  it("marks disabled and restored-after-change baselines without probing", async () => {
    const cap = capability();
    const scan = adapter({ status: "report", value: report(1) });
    const service = createJscpdBaselineService(cap.service, scan.service);

    await expect(service.start(context({ enabled: false }))).resolves.toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    await expect(service.start(context({ hasPriorChanges: true }))).resolves.toEqual({
      status: "partial",
      reason: "restored-after-changes",
    });
    expect(cap.probe).not.toHaveBeenCalled();
    expect(scan.run).not.toHaveBeenCalled();
  });

  it("deduplicates waiters and discards a stale completion after invalidation", async () => {
    let resolveRun!: (value: JscpdRunResult<JscpdScanReport>) => void;
    const run = vi.fn(
      () => new Promise<JscpdRunResult<JscpdScanReport>>((resolve) => (resolveRun = resolve)),
    ) as unknown as JscpdService["run"];
    const service = createJscpdBaselineService(capability().service, {
      run,
      invalidate() {},
      async dispose() {},
    });

    const started = service.start(context());
    const waiting = service.wait();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(service.current()).toEqual({ status: "pending" });

    service.invalidate();
    resolveRun({ status: "report", value: report(1) });

    await expect(Promise.all([started, waiting])).resolves.toEqual([
      { status: "cancelled", stage: "lifecycle" },
      { status: "cancelled", stage: "lifecycle" },
    ]);
    expect(service.current()).toEqual({ status: "unstarted" });
  });

  it("aborts active work when disabled and never rejects background callers", async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn((request: JscpdRunRequest<JscpdScanReport>) => {
      signal = request.signal;
      return new Promise<JscpdRunResult<JscpdScanReport>>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), {
          once: true,
        });
      });
    }) as unknown as JscpdService["run"];
    const service = createJscpdBaselineService(capability().service, {
      run,
      invalidate() {},
      async dispose() {},
    });
    const started = service.start(context());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    service.disable();

    expect(signal?.aborted).toBe(true);
    await expect(started).resolves.toEqual({ status: "cancelled", stage: "lifecycle" });
    expect(service.current()).toEqual({ status: "unavailable", reason: "disabled" });
  });

  it("fails open for an unavailable project without probing", async () => {
    const cap = capability();
    const service = createJscpdBaselineService(
      cap.service,
      adapter({ status: "report", value: report(1) }).service,
    );

    await expect(service.start(context({ cwd: join(root, "missing") }))).resolves.toEqual({
      status: "failed",
      stage: "project",
      reason: "invalid-project",
    });
    expect(cap.probe).not.toHaveBeenCalled();
  });
});
