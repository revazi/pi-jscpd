import { statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJscpdService,
  type JscpdReportDecision,
  type JscpdRunRequest,
  type JscpdService,
} from "../src/jscpd.js";

const FAKE_EXECUTABLE_SOURCE = String.raw`
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, reportPath, ...rest] = process.argv.slice(2);
switch (mode) {
  case "report":
    writeFileSync(reportPath, rest[0] ?? "artifact");
    break;
  case "none":
    break;
  case "nonzero":
    process.stderr.write("private source and environment diagnostic");
    process.exitCode = 7;
    break;
  case "hang":
    if (rest[0]) writeFileSync(rest[0], "started");
    setInterval(() => {}, 1_000);
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    break;
  case "output":
    process.stdout.write("private-stdout".repeat(Number(rest[0] ?? 1_000)));
    process.stderr.write("private-stderr".repeat(Number(rest[0] ?? 1_000)));
    setInterval(() => {}, 1_000);
    break;
  case "large-report":
    writeFileSync(reportPath, "x".repeat(Number(rest[0] ?? 1_000)));
    break;
  case "directory-report":
    mkdirSync(reportPath);
    break;
  case "symlink-report":
    symlinkSync(rest[0], reportPath);
    break;
  case "delay":
    appendFileSync(rest[0], "start:" + rest[1] + "\n");
    await new Promise((resolve) => setTimeout(resolve, Number(rest[2] ?? 80)));
    appendFileSync(rest[0], "end:" + rest[1] + "\n");
    writeFileSync(reportPath, rest[1]);
    break;
  case "tree": {
    const worker = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ], { stdio: "ignore" });
    writeFileSync(rest[0], String(worker.pid));
    setInterval(() => {}, 1_000);
    break;
  }
  default:
    process.exitCode = 9;
}
`;

let fixtureRoot: string;
let projectDirectory: string;
let temporaryRoot: string;
let fakeExecutable: string;
let services: JscpdService[];

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-jscpd-adapter-test-"));
  projectDirectory = join(fixtureRoot, "project");
  temporaryRoot = join(fixtureRoot, "temporary");
  fakeExecutable = join(fixtureRoot, "fake-jscpd.mjs");
  services = [];
  await Promise.all([
    mkdir(projectDirectory, { mode: 0o700 }),
    mkdir(temporaryRoot, { mode: 0o700 }),
    writeFile(fakeExecutable, FAKE_EXECUTABLE_SOURCE, { mode: 0o700 }),
  ]);
  await chmod(fakeExecutable, 0o700);
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.dispose()));
  await rm(fixtureRoot, { recursive: true, force: true });
});

function createService(overrides: Parameters<typeof createJscpdService>[0] = {}): JscpdService {
  const service = createJscpdService({ temporaryRoot, timeoutMs: 1_000, ...overrides });
  services.push(service);
  return service;
}

function request<T = string>(
  mode: string,
  options: {
    signal?: AbortSignal;
    extraArgs?: readonly string[];
    consumeReport?: JscpdRunRequest<T>["consumeReport"];
    executable?: string;
    cwd?: string;
    onReportPath?: (reportPath: string) => void;
  } = {},
): JscpdRunRequest<T> {
  return {
    executable: options.executable ?? process.execPath,
    cwd: options.cwd ?? projectDirectory,
    signal: options.signal,
    createArguments({ reportPath }) {
      options.onReportPath?.(reportPath);
      return [fakeExecutable, mode, reportPath, ...(options.extraArgs ?? [])];
    },
    consumeReport:
      options.consumeReport ??
      ((report) =>
        ({
          status: "accepted",
          value: Buffer.from(report).toString("utf8"),
        }) as JscpdReportDecision<T>),
  };
}

async function expectTemporaryRootClean(): Promise<void> {
  await expect(readdir(temporaryRoot)).resolves.toEqual([]);
}

async function waitForStart(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe("jscpd temporary report adapter", () => {
  it("consumes a bounded artifact before removing its restrictive out-of-tree workspace", async () => {
    const service = createService();
    let reportPath = "";
    let directoryMode = 0;

    const result = await service.run(
      request("report", {
        extraArgs: ["bounded artifact"],
        onReportPath(path) {
          reportPath = path;
          directoryMode = statSyncMode(dirname(path));
        },
      }),
    );

    expect(result).toEqual({ status: "report", value: "bounded artifact" });
    expect(isAbsolute(reportPath)).toBe(true);
    expect(basename(reportPath)).toBe("jscpd-report.json");
    expect(relative(projectDirectory, reportPath).startsWith("..")).toBe(true);
    expect(relative(await realpath(temporaryRoot), reportPath).startsWith("..")).toBe(false);
    expect(directoryMode).toBe(0o700);
    await expectTemporaryRootClean();
  });

  it("types a validated clean report separately from an absent report", async () => {
    const service = createService();
    const clean = service.run(
      request("report", {
        consumeReport: () => ({ status: "no-findings" }),
      }),
    );
    const consumeAbsent = vi.fn<JscpdRunRequest<string>["consumeReport"]>(() => ({
      status: "accepted",
      value: "unexpected",
    }));
    const absent = service.run(request("none", { consumeReport: consumeAbsent }));

    await expect(clean).resolves.toEqual({ status: "no-findings" });
    await expect(absent).resolves.toEqual({ status: "no-report" });
    expect(consumeAbsent).not.toHaveBeenCalled();
    await expectTemporaryRootClean();
  });

  it("normalizes nonzero and spawn failures without exposing child diagnostics", async () => {
    const service = createService();

    const nonzero = await service.run(request("nonzero"));
    const missing = await service.run(
      request("none", { executable: join(fixtureRoot, "missing-jscpd") }),
    );

    expect(nonzero).toEqual({ status: "failed", reason: "nonzero-exit", exitCode: 7 });
    expect(missing).toEqual({ status: "failed", reason: "spawn-failed" });
    expect(JSON.stringify([nonzero, missing])).not.toContain("private");
    await expectTemporaryRootClean();
  });

  it("bounds execution time and escalates termination for a resistant process", async () => {
    const service = createService({ timeoutMs: 30 });

    await expect(service.run(request("ignore-term"))).resolves.toEqual({
      status: "timed-out",
      timeoutMs: 30,
    });
    await expectTemporaryRootClean();
  });

  it("cancels an active process tree and removes its workspace", async () => {
    const service = createService();
    const marker = join(fixtureRoot, "tree-pid");
    const controller = new AbortController();
    const active = service.run(request("tree", { signal: controller.signal, extraArgs: [marker] }));
    await waitForStart();
    const descendantPid = Number(await readFile(marker, "utf8"));

    controller.abort();

    await expect(active).resolves.toEqual({ status: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expectProcessNotRunning(descendantPid);
    await expectTemporaryRootClean();
  });

  it("removes a cancelled queued request without ever starting its child", async () => {
    const service = createService();
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const firstMarker = join(fixtureRoot, "first-started");
    const queuedMarker = join(fixtureRoot, "queued-started");
    const first = service.run(
      request("hang", { signal: firstController.signal, extraArgs: [firstMarker] }),
    );
    const queued = service.run(
      request("hang", { signal: queuedController.signal, extraArgs: [queuedMarker] }),
    );

    queuedController.abort();
    firstController.abort();

    await expect(queued).resolves.toEqual({ status: "cancelled" });
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(readFile(queuedMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expectTemporaryRootClean();
  });

  it("serializes concurrent requests", async () => {
    const service = createService();
    const activity = join(fixtureRoot, "activity.log");

    const first = service.run(request("delay", { extraArgs: [activity, "one", "60"] }));
    const second = service.run(request("delay", { extraArgs: [activity, "two", "10"] }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "report", value: "one" },
      { status: "report", value: "two" },
    ]);
    await expect(readFile(activity, "utf8")).resolves.toBe(
      "start:one\nend:one\nstart:two\nend:two\n",
    );
    await expectTemporaryRootClean();
  });

  it("bounds combined child output", async () => {
    const service = createService({ maxOutputBytes: 20 });

    const result = await service.run(request("output", { extraArgs: ["1"] }));

    expect(result).toEqual({ status: "failed", reason: "output-limit" });
    expect(JSON.stringify(result)).not.toContain("private");
    await expectTemporaryRootClean();
  });

  it("rejects oversized reports without passing bytes to the consumer", async () => {
    const service = createService({ maxReportBytes: 32 });
    const consumeReport = vi.fn<JscpdRunRequest<string>["consumeReport"]>(() => ({
      status: "accepted",
      value: "unexpected",
    }));

    await expect(
      service.run(request("large-report", { extraArgs: ["128"], consumeReport })),
    ).resolves.toEqual({ status: "failed", reason: "report-too-large" });
    expect(consumeReport).not.toHaveBeenCalled();
    await expectTemporaryRootClean();
  });

  it("rejects non-file and symlink report artifacts", async () => {
    const service = createService();
    const outsideArtifact = join(projectDirectory, "outside-report.json");
    await writeFile(outsideArtifact, "private artifact");

    await expect(service.run(request("directory-report"))).resolves.toEqual({
      status: "failed",
      reason: "invalid-report",
    });
    await expect(
      service.run(request("symlink-report", { extraArgs: [outsideArtifact] })),
    ).resolves.toEqual({ status: "failed", reason: "invalid-report" });
    await expectTemporaryRootClean();
  });

  it("normalizes malformed-report consumer failures and bounds report consumption", async () => {
    const service = createService({ reportConsumptionTimeoutMs: 20 });
    const malformed = service.run(
      request("report", {
        consumeReport: () => {
          throw new Error("private malformed report contents");
        },
      }),
    );
    const stalled = service.run(
      request("report", {
        consumeReport: () => new Promise(() => undefined),
      }),
    );

    await expect(malformed).resolves.toEqual({ status: "failed", reason: "consumer-failed" });
    await expect(stalled).resolves.toEqual({ status: "failed", reason: "consumer-timed-out" });
    await expectTemporaryRootClean();
  });

  it("cleans after invalidation and permits later work", async () => {
    const service = createService();
    const controller = new AbortController();
    const active = service.run(request("hang", { signal: controller.signal }));
    const queued = service.run(request("report"));

    service.invalidate();

    await expect(active).resolves.toEqual({ status: "invalidated" });
    await expect(queued).resolves.toEqual({ status: "invalidated" });
    await expect(service.run(request("report"))).resolves.toEqual({
      status: "report",
      value: "artifact",
    });
    await expectTemporaryRootClean();
  });

  it("disposes idempotently, drains active and queued work, and rejects later requests", async () => {
    const service = createService();
    const active = service.run(request("hang"));
    const queuedMarker = join(fixtureRoot, "queued-after-dispose");
    const queued = service.run(request("hang", { extraArgs: [queuedMarker] }));

    const firstDispose = service.dispose();
    const secondDispose = service.dispose();

    expect(secondDispose).toBe(firstDispose);
    await expect(active).resolves.toEqual({ status: "failed", reason: "service-disposed" });
    await expect(queued).resolves.toEqual({ status: "failed", reason: "service-disposed" });
    await expect(firstDispose).resolves.toBeUndefined();
    await expect(service.run(request("report"))).resolves.toEqual({
      status: "failed",
      reason: "service-disposed",
    });
    await expect(readFile(queuedMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expectTemporaryRootClean();
  });

  it("rejects unsafe tokens before creating temporary state and detaches caller listeners", async () => {
    const service = createService();
    const invalidExecutable = request("report", { executable: "bad\0executable" });
    const invalidArgument = request("report");
    invalidArgument.createArguments = () => ["bad\0argument"];
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(service.run(invalidExecutable)).resolves.toEqual({
      status: "failed",
      reason: "invalid-request",
    });
    await expect(service.run(invalidArgument)).resolves.toEqual({
      status: "failed",
      reason: "argument-construction",
    });
    await expect(
      service.run(request("report", { signal: controller.signal })),
    ).resolves.toMatchObject({ status: "report" });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    await expectTemporaryRootClean();
  });

  it("cleans temporary setup failures and creates nothing for pre-cancelled work", async () => {
    const service = createService();
    const controller = new AbortController();
    const createArguments = vi.fn(() => ["unexpected"]);
    controller.abort();

    await expect(
      service.run({
        ...request("report"),
        signal: controller.signal,
        createArguments,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(createArguments).not.toHaveBeenCalled();
    await expect(
      service.run(request("report", { cwd: join(fixtureRoot, "missing-project") })),
    ).resolves.toEqual({ status: "failed", reason: "temporary-directory" });
    await expectTemporaryRootClean();
  });

  it("is lazy at construction and rejects a temporary root inside the project", async () => {
    const nestedTemporaryRoot = join(projectDirectory, "unsafe-temp");
    await mkdir(nestedTemporaryRoot);
    const before = await readdir(nestedTemporaryRoot);
    const service = createService({ temporaryRoot: nestedTemporaryRoot });

    expect(await readdir(nestedTemporaryRoot)).toEqual(before);
    await expect(service.run(request("report"))).resolves.toEqual({
      status: "failed",
      reason: "unsafe-temporary-path",
    });
    expect(await readdir(nestedTemporaryRoot)).toEqual([]);
  });
});

function statSyncMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function expectProcessNotRunning(pid: number): void {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
}
