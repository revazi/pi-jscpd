import { describe, expect, it, vi } from "vitest";
import type { JscpdCapabilityResult, JscpdCapabilityService } from "../src/capability.js";
import type { JscpdConfigLoadResult, JscpdConfigService } from "../src/config.js";
import { createJscpdStatusAwareExecutor, createJscpdStatusService } from "../src/status.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";

function capabilityService(result: JscpdCapabilityResult) {
  const probe = vi.fn<JscpdCapabilityService["probe"]>(async () => result);
  return {
    service: { probe, invalidate() {}, dispose() {} } satisfies JscpdCapabilityService,
    probe,
  };
}

function configService(overrides: Partial<JscpdConfigLoadResult> = {}): JscpdConfigService {
  const result: JscpdConfigLoadResult = {
    config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
    sources: ["defaults"],
    diagnostics: [],
    trusted: true,
    ...overrides,
  };
  return {
    async load() {
      return result;
    },
    current() {
      return result;
    },
  };
}

function completed(outcome: "clean" | "findings", clones = 0): JscpdExecutionResult {
  return {
    status: "completed",
    outcome,
    message: "bounded scan result",
    terminalMessage: "bounded scan result",
    summary: {
      clones,
      duplicatedLines: clones,
      duplicatedTokens: clones,
      lines: 10,
      tokens: 20,
      sources: 2,
      percentage: 10,
      percentageTokens: 10,
    },
    findings: [],
    omittedFindings: 0,
  };
}

const available: JscpdCapabilityResult = {
  status: "available",
  executable: "jscpd",
  version: "5.1.1",
  major: 5,
};

describe("bounded jscpd status", () => {
  it("reports binary, effective config source, mode, diagnostics, and never-run state", async () => {
    const capability = capabilityService(available);
    const config = configService({
      config: { enabled: false, timeoutMs: 45_000, maxFindings: 3 },
      sources: ["defaults", "project", "local"],
      diagnostics: [
        {
          source: "project",
          code: "invalid-value",
          message: "private diagnostic detail must not be repeated",
        },
      ],
    });
    const service = createJscpdStatusService(capability.service, config);

    const result = await service.inspect({ cwd: "/project" });

    expect(result).toMatchObject({
      status: "status",
      mode: "disabled",
      configSource: "local",
      configSources: ["defaults", "project", "local"],
      configDiagnostics: 1,
      capability: available,
      lastCheck: { state: "never" },
    });
    expect(result.message).toContain("Binary: jscpd v5.1.1");
    expect(result.message).toContain(".pi/jscpd-guardrail.local.json (local override)");
    expect(result.message).toContain("State: disabled");
    expect(result.message).toContain("Last check: never run");
    expect(result.message).toContain("1 invalid source ignored");
    expect(result.message).not.toContain("private diagnostic detail");
    expect(result.message.length).toBeLessThan(1_000);
    expect(result.terminalMessage).toBe(result.message);
  });

  it("explains dormant setup without leaking PATH or environment content", async () => {
    const capability = capabilityService({ status: "missing", checked: ["jscpd", "cpd"] });
    const service = createJscpdStatusService(capability.service, configService());

    const result = await service.inspect({ cwd: "/private/project" });

    expect(result.message).toContain("Binary: unavailable (checked jscpd and cpd)");
    expect(result.message).toContain("State: dormant");
    expect(result.message).toContain("install jscpd v5");
    expect(result.message).not.toContain("/private/project");
    expect(capability.probe).toHaveBeenCalledWith({
      cwd: "/private/project",
      signal: undefined,
    });
  });

  it.each([
    [completed("clean"), { state: "clean" }, "Last check: clean"],
    [completed("findings", 2), { state: "findings", clones: 2 }, "2 duplicate blocks found"],
    [
      { status: "failed", reason: "scan-cancelled", message: "cancelled" } as const,
      { state: "cancelled" },
      "Last check: cancelled",
    ],
    [
      { status: "failed", reason: "invalid-report", message: "failed" } as const,
      { state: "failed", reason: "invalid-report" },
      "Last check: failed (invalid report)",
    ],
  ] as const)("records a bounded last-check state for %j", async (scan, expected, text) => {
    const service = createJscpdStatusService(capabilityService(available).service, configService());

    service.record(scan);
    const result = await service.inspect({ cwd: "/project" });

    expect(result.lastCheck).toEqual(expected);
    expect(result.message).toContain(text);
    service.reset();
    await expect(service.inspect({ cwd: "/project" })).resolves.toMatchObject({
      lastCheck: { state: "never" },
    });
  });

  it("routes status without scanning and records scan results for the next status", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => completed("findings", 1));
    const status = createJscpdStatusService(capabilityService(available).service, configService());
    const executor = createJscpdStatusAwareExecutor({ execute }, status);

    const firstStatus = await executor.execute(
      { command: "status", args: [] },
      { cwd: "/project" },
    );
    const scan = await executor.execute({ command: "scan", args: [] }, { cwd: "/project" });
    const secondStatus = await executor.execute(
      { command: "status", args: [] },
      { cwd: "/project" },
    );

    expect(firstStatus).toMatchObject({ status: "status", lastCheck: { state: "never" } });
    expect(scan).toMatchObject({ status: "completed", outcome: "findings" });
    expect(secondStatus).toMatchObject({
      status: "status",
      lastCheck: { state: "findings", clones: 1 },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ command: "scan", args: [] }, { cwd: "/project" });
  });
});
