import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { JscpdCapabilityResult } from "../src/capability.js";
import type { JscpdConfigLoadResult, JscpdConfigService } from "../src/config.js";
import { JscpdTestEffectRuntime } from "../src/effect/runtime-boundary.js";
import { createJscpdFallowCoexistenceService } from "../src/fallow.js";
import {
  createJscpdSessionModeService,
  createJscpdStatusAwareExecutor,
  createJscpdStatusService,
} from "../src/status.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";
import { capabilityFromPromise, type TestCapabilityProbe } from "./support/capability.js";

function capabilityService(result: JscpdCapabilityResult) {
  const probe = vi.fn<TestCapabilityProbe>(async () => result);
  return {
    service: capabilityFromPromise(probe),
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
    loadEffect: () => Effect.succeed(result),
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

function sessionMode(enabled = true) {
  const mode = createJscpdSessionModeService();
  mode.restore(enabled);
  return mode;
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
    const service = createJscpdStatusService(capability.service, config, sessionMode(false));

    const result = await service.inspect({ cwd: "/project" });

    expect(result).toMatchObject({
      status: "status",
      mode: "disabled",
      modeSource: "configuration",
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

  it("reports explicit Fallow coexistence and automatic on-demand state", async () => {
    const coexistence = createJscpdFallowCoexistenceService();
    await JscpdTestEffectRuntime.runPromise(
      coexistence.evaluateEffect({
        cwd: "/not-inspected",
        trusted: true,
        policy: "on-demand",
        fallowToolAvailable: true,
      }),
    );
    const service = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      sessionMode(),
      coexistence,
    );

    const result = await service.inspect({ cwd: "/project" });

    expect(result).toMatchObject({
      fallowOverlap: "explicit-on-demand",
      fallowAutomatic: "on-demand",
    });
    expect(result.message).toContain(
      "Fallow coexistence: jscpd automatic checks explicitly on demand",
    );
  });

  it("explains dormant setup without leaking PATH or environment content", async () => {
    const capability = capabilityService({ status: "missing", checked: ["jscpd", "cpd"] });
    const service = createJscpdStatusService(capability.service, configService(), sessionMode());

    const result = await service.inspect({ cwd: "/private/project" });

    expect(result.message).toContain(
      "Binary: unavailable (checked project, PATH, and bundled jscpd)",
    );
    expect(result.message).toContain("State: dormant");
    expect(result.message).toContain("reinstall pi-jscpd");
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
    [
      { status: "unavailable", reason: "probe-cancelled", message: "cancelled" } as const,
      { state: "cancelled" },
      "Last check: cancelled",
    ],
    [
      { status: "unavailable", reason: "disabled", message: "disabled" } as const,
      { state: "failed", reason: "disabled" },
      "Last check: failed (disabled)",
    ],
    [
      {
        status: "changed",
        outcome: "clean",
        scanPerformed: true,
        message: "clean",
        terminalMessage: "clean",
        findings: [],
        omittedFindings: 0,
        ambiguousFindings: 0,
      } as const,
      { state: "clean" },
      "Last check: clean",
    ],
    [
      {
        status: "changed",
        outcome: "findings",
        scanPerformed: true,
        message: "findings",
        terminalMessage: "findings",
        findings: [],
        omittedFindings: 2,
        ambiguousFindings: 0,
      } as const,
      { state: "findings", clones: 2 },
      "2 duplicate blocks found",
    ],
    [
      {
        status: "changed",
        outcome: "clean",
        scanPerformed: false,
        message: "empty",
        terminalMessage: "empty",
        findings: [],
        omittedFindings: 0,
        ambiguousFindings: 0,
      } as const,
      { state: "never" },
      "Last check: never run",
    ],
  ] as const)("records a bounded last-check state for %j", async (scan, expected, text) => {
    const service = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      sessionMode(),
    );

    service.record(scan);
    const result = await service.inspect({ cwd: "/project" });

    expect(result.lastCheck).toEqual(expected);
    expect(result.message).toContain(text);
    service.restore();
    await expect(service.inspect({ cwd: "/project" })).resolves.toMatchObject({
      lastCheck: { state: "never" },
    });
  });

  it("disables and re-enables the current session while generating help from the registry", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => completed("clean"));
    const mode = sessionMode();
    const status = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      mode,
    );
    const stateChanged = vi.fn();
    const executor = createJscpdStatusAwareExecutor({ execute }, status, mode, stateChanged);

    const disabled = await executor.execute({ command: "off", args: [] }, { cwd: "/project" });
    const disabledStatus = await executor.execute(
      { command: "status", args: [] },
      { cwd: "/project" },
    );
    const help = await executor.execute({ command: "help", args: [] }, { cwd: "/project" });
    const enabled = await executor.execute({ command: "on", args: [] }, { cwd: "/project" });
    const enabledStatus = await executor.execute(
      { command: "status", args: [] },
      { cwd: "/project" },
    );

    expect(disabled).toMatchObject({ status: "control", action: "disabled" });
    expect(disabledStatus).toMatchObject({
      status: "status",
      mode: "disabled",
      modeSource: "session",
      lastCheck: { state: "never" },
    });
    expect(disabledStatus.message).toContain("run /jscpd on");
    expect(help).toMatchObject({ status: "help" });
    expect(help.message).toContain("/jscpd scan [target ...]");
    expect(help.message).toContain("/jscpd off");
    expect(help.message).toContain("/jscpd on");
    expect(help.message).toContain("/jscpd help");
    expect(enabled).toMatchObject({ status: "control", action: "enabled" });
    expect(enabledStatus).toMatchObject({
      status: "status",
      mode: "enabled",
      modeSource: "session",
      lastCheck: { state: "never" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(stateChanged).toHaveBeenCalledTimes(2);
  });

  it("routes a completed changed check through its dedicated executor and records its status", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => completed("clean"));
    const changedExecute = vi.fn<JscpdCommandExecutor["execute"]>(async () => ({
      status: "changed",
      outcome: "clean",
      scanPerformed: true,
      message: "no new session duplication",
      terminalMessage: "no new session duplication",
      findings: [],
      omittedFindings: 0,
      ambiguousFindings: 0,
    }));
    const mode = sessionMode();
    const status = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      mode,
    );
    const stateChanged = vi.fn();
    const executor = createJscpdStatusAwareExecutor({ execute }, status, mode, stateChanged, {
      execute: changedExecute,
    });

    await expect(
      executor.execute({ command: "changed", args: [] }, { cwd: "/project" }),
    ).resolves.toMatchObject({ status: "changed", outcome: "clean" });
    expect(changedExecute).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(stateChanged).toHaveBeenCalledOnce();
    expect(status.lastCheck()).toEqual({ state: "clean" });
  });

  it("does not record a clean check when changed short-circuits before scanning", async () => {
    const changedExecute = vi.fn<JscpdCommandExecutor["execute"]>(async () => ({
      status: "changed",
      outcome: "clean",
      scanPerformed: false,
      message: "no tracked files",
      terminalMessage: "no tracked files",
      findings: [],
      omittedFindings: 0,
      ambiguousFindings: 0,
    }));
    const mode = sessionMode();
    const status = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      mode,
    );
    const executor = createJscpdStatusAwareExecutor(
      { execute: async () => completed("clean") },
      status,
      mode,
      undefined,
      { execute: changedExecute },
    );

    await executor.execute({ command: "changed", args: [] }, { cwd: "/project" });

    expect(status.lastCheck()).toEqual({ state: "never" });
  });

  it("routes status without scanning and records scan results for the next status", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => completed("findings", 1));
    const mode = sessionMode();
    const status = createJscpdStatusService(
      capabilityService(available).service,
      configService(),
      mode,
    );
    const stateChanged = vi.fn();
    const executor = createJscpdStatusAwareExecutor({ execute }, status, mode, stateChanged);

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
    expect(stateChanged).toHaveBeenCalledOnce();
  });
});
