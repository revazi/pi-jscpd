import { describe, expect, it, vi } from "vitest";
import {
  createJscpdCapabilityService,
  createNodeProbeExecutor,
  JSCPD_SUPPORTED_MAJOR,
  JSCPD_VERSION_MAX_OUTPUT_BYTES,
  JSCPD_VERSION_TIMEOUT_MS,
  type JscpdExecutable,
  type JscpdProbeExecutionRequest,
  type JscpdProbeExecutionResult,
  type JscpdProbeExecutor,
  parseJscpdVersion,
} from "../src/capability.js";

const project = { cwd: "/project", path: "/synthetic/bin" } as const;

function fakeExecutor(...results: JscpdProbeExecutionResult[]) {
  const calls: JscpdProbeExecutionRequest[] = [];
  const run = vi.fn<JscpdProbeExecutor["run"]>(async (request) => {
    calls.push(request);
    const result = results.shift();
    if (!result) {
      throw new Error("Unexpected probe");
    }
    return result;
  });
  return { executor: { run }, calls, run };
}

function completed(stdout: string, exitCode = 0, stderr = ""): JscpdProbeExecutionResult {
  return { status: "completed", exitCode, stdout, stderr };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("jscpd version parsing", () => {
  it.each([
    ["5.0.0", "5.0.0"],
    ["v5.1.2\n", "5.1.2"],
    ["jscpd 5.2.3", "5.2.3"],
    ["jscpd version v5.3.4-beta.1+local", "5.3.4-beta.1+local"],
    ["cpd 5.4.0", "5.4.0"],
    ["cpd version: v5.5.1", "5.5.1"],
  ])("accepts a realistic bounded version line: %s", (output, version) => {
    expect(parseJscpdVersion(output)).toEqual({ version, major: JSCPD_SUPPORTED_MAJOR });
  });

  it.each([
    "",
    "jscpd",
    "release 5.0.0 is ready",
    "5.0",
    "05.0.0",
    "warning\n5.0.0",
    `5.0.0${"x".repeat(128)}`,
  ])("rejects ambiguous or malformed output: %s", (output) => {
    expect(parseJscpdVersion(output)).toBeUndefined();
  });
});

describe("jscpd capability probing", () => {
  it("probes jscpd first with a bounded shell-free version request", async () => {
    const fake = fakeExecutor(completed("jscpd version v5.2.1\n"));
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual({
      status: "available",
      executable: "jscpd",
      version: "5.2.1",
      major: 5,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      executable: "jscpd",
      args: ["--version"],
      cwd: project.cwd,
      path: project.path,
      timeoutMs: JSCPD_VERSION_TIMEOUT_MS,
      maxOutputBytes: JSCPD_VERSION_MAX_OUTPUT_BYTES,
    });
  });

  it("falls back to and recognizes cpd output only when jscpd is missing", async () => {
    const fake = fakeExecutor({ status: "missing" }, completed("cpd version 5.4.0"));
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual({
      status: "available",
      executable: "cpd",
      version: "5.4.0",
      major: 5,
    });
    expect(fake.calls.map(({ executable }) => executable)).toEqual(["jscpd", "cpd"]);
  });

  it("reports both supported command names missing without searching elsewhere", async () => {
    const fake = fakeExecutor({ status: "missing" }, { status: "missing" });
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual({
      status: "missing",
      checked: ["jscpd", "cpd"],
    });
    expect(fake.calls.map(({ executable }) => executable)).toEqual(["jscpd", "cpd"]);
  });

  it("reports an incompatible major and does not try a fallback", async () => {
    const fake = fakeExecutor(completed("jscpd 4.2.0"));
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual({
      status: "incompatible",
      executable: "jscpd",
      version: "4.2.0",
      major: 4,
      supportedMajor: 5,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("accepts a version emitted on stderr when stdout is empty", async () => {
    const fake = fakeExecutor(completed("", 0, "jscpd v5.6.0\n"));
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual({
      status: "available",
      executable: "jscpd",
      version: "5.6.0",
      major: 5,
    });
  });

  it.each([
    {
      name: "malformed output",
      execution: completed("warning: unexpected output\n5.0.0"),
      expected: { status: "failed", executable: "jscpd", reason: "malformed-version" },
    },
    {
      name: "a nonzero exit",
      execution: completed("5.0.0", 2, "private diagnostic"),
      expected: {
        status: "failed",
        executable: "jscpd",
        reason: "nonzero-exit",
        exitCode: 2,
      },
    },
    {
      name: "a timeout",
      execution: { status: "timed-out" } as const,
      expected: {
        status: "timed-out",
        executable: "jscpd",
        timeoutMs: JSCPD_VERSION_TIMEOUT_MS,
      },
    },
    {
      name: "the executor output bound",
      execution: { status: "output-limit" } as const,
      expected: { status: "failed", executable: "jscpd", reason: "output-limit" },
    },
    {
      name: "an execution failure",
      execution: { status: "failed" } as const,
      expected: { status: "failed", executable: "jscpd", reason: "execution-error" },
    },
  ])("stops after $name from a probe that started", async ({ execution, expected }) => {
    const fake = fakeExecutor(execution);
    const service = createJscpdCapabilityService(fake.executor);

    await expect(service.probe(project)).resolves.toEqual(expected);
    expect(fake.calls.map(({ executable }) => executable)).toEqual(["jscpd"]);
  });

  it("propagates cancellation and does not try a fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const signals: AbortSignal[] = [];
    const executor: JscpdProbeExecutor = {
      async run(request) {
        signals.push(request.signal);
        return request.signal.aborted ? { status: "cancelled" } : completed("5.0.0");
      },
    };
    const service = createJscpdCapabilityService(executor);

    await expect(service.probe({ ...project, signal: controller.signal })).resolves.toEqual({
      status: "cancelled",
      executable: "jscpd",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("converts oversized injected output to a bounded diagnostic without returning it", async () => {
    const oversized = `5.0.0${"private".repeat(JSCPD_VERSION_MAX_OUTPUT_BYTES)}`;
    const fake = fakeExecutor(completed(oversized));
    const service = createJscpdCapabilityService(fake.executor);

    const result = await service.probe(project);

    expect(result).toEqual({
      status: "failed",
      executable: "jscpd",
      reason: "output-limit",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fake.calls).toHaveLength(1);
  });

  it("normalizes thrown executor errors without exposing them or falling back", async () => {
    const run = vi.fn<JscpdProbeExecutor["run"]>(async () => {
      throw new Error("private environment and output");
    });
    const service = createJscpdCapabilityService({ run });

    const result = await service.probe(project);

    expect(result).toEqual({
      status: "failed",
      executable: "jscpd",
      reason: "execution-error",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(run).toHaveBeenCalledOnce();
  });

  it("detaches caller cancellation listeners after a completed probe", async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const fake = fakeExecutor(completed("5.0.0"));
    const service = createJscpdCapabilityService(fake.executor);

    await service.probe({ ...project, signal: controller.signal });

    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith("abort", addEventListener.mock.calls[0]?.[1]);
  });
});

describe("bounded process boundary", () => {
  function nodeRequest(
    args: readonly string[],
    overrides: Partial<JscpdProbeExecutionRequest> = {},
  ): JscpdProbeExecutionRequest {
    return {
      executable: process.execPath as JscpdExecutable,
      args,
      cwd: process.cwd(),
      path: process.env.PATH ?? "",
      signal: new AbortController().signal,
      timeoutMs: 500,
      maxOutputBytes: 128,
      ...overrides,
    };
  }

  it("passes argument tokens directly without shell interpretation", async () => {
    const executor = createNodeProbeExecutor();

    await expect(
      executor.run(nodeRequest(["-e", "process.stdout.write(process.argv[1])", "$HOME;exit 9"])),
    ).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "$HOME;exit 9",
      stderr: "",
    });
  });

  it("terminates a process when its combined output reaches the byte bound", async () => {
    const executor = createNodeProbeExecutor();

    await expect(
      executor.run(nodeRequest(["-e", 'process.stdout.write("x".repeat(1024))'])),
    ).resolves.toEqual({ status: "output-limit" });
  });

  it("terminates timed-out and cancelled processes with typed outcomes", async () => {
    const executor = createNodeProbeExecutor();
    const script = "setInterval(() => {}, 1000)";
    const controller = new AbortController();
    const cancelled = executor.run(
      nodeRequest(["-e", script], { signal: controller.signal, timeoutMs: 500 }),
    );
    controller.abort();

    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    await expect(executor.run(nodeRequest(["-e", script], { timeoutMs: 20 }))).resolves.toEqual({
      status: "timed-out",
    });
  });

  it("does not spawn when cancellation has already been requested", async () => {
    const executor = createNodeProbeExecutor();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.run(nodeRequest(["-e", "process.exit(9)"], { signal: controller.signal })),
    ).resolves.toEqual({ status: "cancelled" });
  });
});

describe("jscpd capability cache lifecycle", () => {
  it("reuses a stable result for the same cwd and PATH", async () => {
    const fake = fakeExecutor(completed("5.0.1"));
    const service = createJscpdCapabilityService(fake.executor);

    const first = await service.probe(project);
    const second = await service.probe(project);

    expect(second).toBe(first);
    expect(fake.run).toHaveBeenCalledOnce();
  });

  it("invalidates when cwd or PATH changes and on explicit reset", async () => {
    const fake = fakeExecutor(
      completed("5.0.0"),
      completed("5.0.1"),
      completed("5.0.2"),
      completed("5.0.3"),
    );
    const service = createJscpdCapabilityService(fake.executor);

    await service.probe(project);
    await service.probe({ ...project, cwd: "/other-project" });
    await service.probe({ ...project, cwd: "/other-project", path: "/other/bin" });
    service.invalidate();
    await service.probe({ ...project, cwd: "/other-project", path: "/other/bin" });

    expect(fake.run).toHaveBeenCalledTimes(4);
  });

  it("does not cache a completed result from an invalidated generation", async () => {
    const firstExecution = deferred<JscpdProbeExecutionResult>();
    let callCount = 0;
    const run = vi.fn<JscpdProbeExecutor["run"]>(() => {
      callCount += 1;
      return callCount === 1 ? firstExecution.promise : Promise.resolve(completed("5.0.1"));
    });
    const service = createJscpdCapabilityService({ run });
    const staleProbe = service.probe(project);

    service.invalidate();
    firstExecution.resolve(completed("5.0.0"));

    await expect(staleProbe).resolves.toMatchObject({ status: "available", version: "5.0.0" });
    await expect(service.probe(project)).resolves.toMatchObject({
      status: "available",
      version: "5.0.1",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels active work on disposal and rejects later probes without execution", async () => {
    const run = vi.fn<JscpdProbeExecutor["run"]>(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), {
            once: true,
          });
        }),
    );
    const service = createJscpdCapabilityService({ run });
    const active = service.probe(project);

    service.dispose();

    await expect(active).resolves.toEqual({ status: "cancelled", executable: "jscpd" });
    await expect(service.probe(project)).resolves.toEqual({
      status: "failed",
      executable: "jscpd",
      reason: "service-disposed",
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
