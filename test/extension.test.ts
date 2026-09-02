import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { JscpdBaselineService, JscpdBaselineState } from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import type { JscpdConfigService } from "../src/config.js";
import {
  createJscpdSlashCommandDefinition,
  createJscpdToolDefinition,
  registerJscpdExtension,
} from "../src/extension.js";
import type { JscpdService } from "../src/jscpd.js";
import { jscpdArgumentHint } from "../src/registry.js";
import { createJscpdScanScheduler } from "../src/scheduler.js";
import { JSCPD_SESSION_STATE_TYPE, JSCPD_SESSION_STATE_VERSION } from "../src/session-state.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../src/types.js";

const unavailableResult = {
  status: "unavailable",
  reason: "missing-binary",
  message: "Unavailable in test.",
} as const;

const changedResult = {
  status: "changed",
  outcome: "clean",
  scanPerformed: true,
  message: "Model changed result in test.",
  terminalMessage: "Terminal changed result in test.",
  findings: [],
  omittedFindings: 0,
  ambiguousFindings: 0,
} as const;

const statusResult = {
  status: "status",
  message: "Model status in test.",
  terminalMessage: "Terminal status in test.",
  mode: "enabled",
  modeSource: "configuration",
  configSource: "defaults",
  configSources: ["defaults"],
  configDiagnostics: 0,
  capability: { status: "missing", checked: ["jscpd", "cpd"] },
  lastCheck: { state: "never" },
} as const;

function createExecutor(result: JscpdExecutionResult = unavailableResult) {
  const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => result);
  return { executor: { execute }, execute };
}

function commandContext(notify = vi.fn()) {
  return {
    notify,
    context: {
      cwd: "/project",
      signal: undefined,
      ui: { notify },
    } as unknown as ExtensionCommandContext,
  };
}

function toolContext(): ExtensionContext {
  return { cwd: "/project", signal: undefined } as unknown as ExtensionContext;
}

function createAdapterService() {
  const invalidate = vi.fn();
  const dispose = vi.fn(async () => undefined);
  return {
    service: { invalidate, dispose } as unknown as JscpdService,
    invalidate,
    dispose,
  };
}

function createConfigService(
  diagnostics: readonly { message: string }[] = [],
  config = { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
) {
  const result = {
    config,
    sources: ["defaults"] as const,
    diagnostics: diagnostics.map(({ message }) => ({
      source: "project" as const,
      code: "invalid-value" as const,
      message,
    })),
    trusted: true,
  };
  const load = vi.fn<JscpdConfigService["load"]>(async () => result);
  return {
    service: { load, current: () => result } satisfies JscpdConfigService,
    load,
  };
}

function createBaselineService(state: JscpdBaselineState = { status: "unstarted" }) {
  let current = state;
  const start = vi.fn<JscpdBaselineService["start"]>(async () => current);
  const wait = vi.fn<JscpdBaselineService["wait"]>(async () => current);
  const disable = vi.fn(() => {
    current = { status: "unavailable", reason: "disabled" };
  });
  const invalidate = vi.fn(() => {
    current = { status: "unstarted" };
  });
  return {
    service: {
      start,
      wait,
      disable,
      invalidate,
      current: () => current,
    } satisfies JscpdBaselineService,
    start,
    wait,
    disable,
    invalidate,
  };
}

function createCapabilityService() {
  const probe = vi.fn<JscpdCapabilityService["probe"]>(async () => ({
    status: "available",
    executable: "jscpd",
    version: "5.1.0",
    major: 5,
  }));
  const invalidate = vi.fn();
  const dispose = vi.fn();
  return {
    service: { probe, invalidate, dispose } satisfies JscpdCapabilityService,
    probe,
    invalidate,
    dispose,
  };
}

describe("Pi extension registration", () => {
  it("registers one jscpd_run tool and one /jscpd command", () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = { registerTool, registerCommand, on } as unknown as ExtensionAPI;
    const capability = createCapabilityService();
    const adapter = createAdapterService();
    const config = createConfigService();

    registerJscpdExtension(pi, {
      capabilityService: capability.service,
      adapterService: adapter.service,
      configService: config.service,
    });

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({
      name: "jscpd_run",
      label: "jscpd",
    });
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand.mock.calls[0]?.[0]).toBe("jscpd");
    expect(registerCommand.mock.calls[0]?.[1]).toMatchObject({
      argumentHint: jscpdArgumentHint,
      getArgumentCompletions: expect.any(Function),
      handler: expect.any(Function),
    });
    expect(capability.probe).not.toHaveBeenCalled();
    expect(on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "session_tree",
      "session_before_switch",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "session_shutdown",
    ]);
  });

  it("applies current trusted configuration to the registered scan executor", async () => {
    const registerTool = vi.fn();
    const capability = createCapabilityService();
    const adapter = createAdapterService();
    const config = createConfigService([], {
      enabled: false,
      timeoutMs: 45_000,
      maxFindings: 3,
    });
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    registerJscpdExtension(
      {
        registerTool,
        registerCommand: vi.fn(),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) =>
          handlers.set(event, handler),
        ),
      } as unknown as ExtensionAPI,
      {
        capabilityService: capability.service,
        adapterService: adapter.service,
        configService: config.service,
      },
    );
    const definition = registerTool.mock.calls[0]?.[0] as ReturnType<
      typeof createJscpdToolDefinition
    >;

    await handlers.get("session_start")?.(
      {},
      {
        cwd: "/project",
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: { notify: vi.fn() },
      },
    );
    const result = await definition.execute(
      "tool-call",
      { command: "scan" },
      undefined,
      undefined,
      toolContext(),
    );

    expect(result.details).toMatchObject({ status: "unavailable", reason: "disabled" });
    expect(capability.probe).not.toHaveBeenCalled();
  });

  it("loads trusted configuration and owns services at session boundaries", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const capability = createCapabilityService();
    const adapter = createAdapterService();
    const config = createConfigService([{ message: "Invalid project configuration." }]);
    const scheduler = createJscpdScanScheduler();
    const resetScheduler = vi.spyOn(scheduler, "reset");
    const cancelAutomatic = vi.spyOn(scheduler, "cancelAutomatic");
    const disposeScheduler = vi.spyOn(scheduler, "dispose");
    const notify = vi.fn();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;

    registerJscpdExtension(pi, {
      capabilityService: capability.service,
      adapterService: adapter.service,
      configService: config.service,
      scheduler,
    });
    await handlers.get("session_start")?.(
      {},
      {
        cwd: "/project",
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: { notify },
      },
    );
    await handlers.get("before_agent_start")?.();
    await handlers.get("session_before_switch")?.();
    await handlers.get("session_shutdown")?.();
    await handlers.get("session_shutdown")?.();

    expect(config.load).toHaveBeenCalledWith({ cwd: "/project", trusted: true });
    expect(notify).toHaveBeenCalledWith("Invalid project configuration.", "warning");
    expect(capability.invalidate).toHaveBeenCalledTimes(2);
    expect(capability.dispose).toHaveBeenCalledOnce();
    expect(adapter.invalidate).toHaveBeenCalledTimes(2);
    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(resetScheduler).toHaveBeenCalledTimes(2);
    expect(cancelAutomatic).toHaveBeenCalledOnce();
    expect(disposeScheduler).toHaveBeenCalledOnce();
  });

  it("persists controls and restores active-branch state on resume, reload, and tree navigation", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const appendEntry = vi.fn();
    const capability = createCapabilityService();
    const adapter = createAdapterService();
    const config = createConfigService();
    const pi = {
      registerTool,
      registerCommand,
      appendEntry,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;
    registerJscpdExtension(pi, {
      capabilityService: capability.service,
      adapterService: adapter.service,
      configService: config.service,
    });
    const command = registerCommand.mock.calls[0]?.[1] as ReturnType<
      typeof createJscpdSlashCommandDefinition
    >;
    const tool = registerTool.mock.calls[0]?.[0] as ReturnType<typeof createJscpdToolDefinition>;
    const startBranch = [
      {
        type: "custom",
        customType: JSCPD_SESSION_STATE_TYPE,
        data: {
          version: JSCPD_SESSION_STATE_VERSION,
          modeOverride: "disabled",
          lastCheck: { state: "findings", clones: 2 },
          changedFiles: ["src/resumed.ts"],
          acknowledgements: {
            identityVersion: 1,
            findings: [
              {
                fingerprint: "a".repeat(64),
                paths: ["src/resumed.ts", "src/shared.ts"],
              },
            ],
          },
        },
      },
    ];

    await handlers.get("session_start")?.(
      { reason: "resume" },
      {
        cwd: "/project",
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => startBranch },
        ui: { notify: vi.fn() },
      },
    );
    const resumed = await tool.execute(
      "tool-call",
      { command: "status" },
      undefined,
      undefined,
      toolContext(),
    );
    expect(resumed.details).toMatchObject({
      status: "status",
      mode: "disabled",
      modeSource: "session",
      lastCheck: { state: "findings", clones: 2 },
    });

    await handlers.get("session_start")?.(
      { reason: "reload" },
      {
        cwd: "/project",
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => startBranch },
        ui: { notify: vi.fn() },
      },
    );
    const reloaded = await tool.execute(
      "tool-call",
      { command: "status" },
      undefined,
      undefined,
      toolContext(),
    );
    expect(reloaded.details).toMatchObject({
      status: "status",
      mode: "disabled",
      modeSource: "session",
      lastCheck: { state: "findings", clones: 2 },
    });

    await command.handler("on", commandContext().context);
    expect(appendEntry).toHaveBeenLastCalledWith(JSCPD_SESSION_STATE_TYPE, {
      version: JSCPD_SESSION_STATE_VERSION,
      modeOverride: "enabled",
      lastCheck: { state: "findings", clones: 2 },
      changedFiles: ["src/resumed.ts"],
      acknowledgements: {
        identityVersion: 1,
        findings: [
          {
            fingerprint: "a".repeat(64),
            paths: ["src/resumed.ts", "src/shared.ts"],
          },
        ],
      },
    });

    await handlers.get("session_tree")?.(
      { newLeafId: "before-state" },
      { cwd: "/project", sessionManager: { getBranch: () => [] } },
    );
    const branched = await tool.execute(
      "tool-call",
      { command: "status" },
      undefined,
      undefined,
      toolContext(),
    );
    expect(branched.details).toMatchObject({
      status: "status",
      mode: "enabled",
      modeSource: "configuration",
      lastCheck: { state: "never" },
    });
    await command.handler("off", commandContext().context);
    expect(appendEntry).toHaveBeenLastCalledWith(JSCPD_SESSION_STATE_TYPE, {
      version: JSCPD_SESSION_STATE_VERSION,
      modeOverride: "disabled",
      lastCheck: { state: "never" },
      changedFiles: [],
      acknowledgements: { identityVersion: 1, findings: [] },
    });
  });

  it("starts baseline capture quietly and waits only before active built-in mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-jscpd-extension-baseline-test-"));
    const project = join(root, "project");
    await mkdir(project);
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    let releaseWait!: () => void;
    const baseline = createBaselineService({ status: "pending" });
    baseline.wait.mockImplementation(
      () =>
        new Promise<JscpdBaselineState>((resolve) => {
          releaseWait = () => resolve({ status: "cancelled", stage: "lifecycle" });
        }),
    );
    const registerCommand = vi.fn();
    const pi = {
      registerTool: vi.fn(),
      registerCommand,
      appendEntry: vi.fn(),
      getAllTools: () => [
        { name: "write", sourceInfo: { source: "builtin" } },
        { name: "edit", sourceInfo: { source: "project-extension" } },
        { name: "read", sourceInfo: { source: "builtin" } },
      ],
      on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;

    try {
      registerJscpdExtension(pi, {
        capabilityService: createCapabilityService().service,
        adapterService: createAdapterService().service,
        configService: createConfigService().service,
        baselineService: baseline.service,
      });
      await handlers.get("session_start")?.(
        { reason: "startup" },
        {
          cwd: project,
          hasUI: false,
          isProjectTrusted: () => true,
          sessionManager: { getBranch: () => [] },
          ui: { notify: vi.fn() },
        },
      );
      expect(baseline.start).toHaveBeenCalledWith({
        cwd: project,
        enabled: true,
        timeoutMs: 30_000,
        hasPriorChanges: false,
      });

      await handlers.get("tool_call")?.({ toolName: "read", input: { path: "x" } }, {});
      await handlers.get("tool_call")?.({ toolName: "edit", input: { path: "x" } }, {});
      expect(baseline.wait).not.toHaveBeenCalled();

      let settled = false;
      const mutation = Promise.resolve(
        handlers.get("tool_call")?.({ toolName: "write", input: { path: "x" } }, {}),
      ).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(baseline.wait).toHaveBeenCalledOnce();
      releaseWait();
      await mutation;
      expect(settled).toBe(true);

      const command = registerCommand.mock.calls[0]?.[1] as ReturnType<
        typeof createJscpdSlashCommandDefinition
      >;
      await command.handler("off", commandContext().context);
      expect(baseline.disable).toHaveBeenCalledOnce();
      await command.handler("on", commandContext().context);
      expect(baseline.start).toHaveBeenCalledTimes(2);
      expect(baseline.start).toHaveBeenLastCalledWith({
        cwd: project,
        enabled: true,
        timeoutMs: 30_000,
        hasPriorChanges: false,
      });

      await handlers.get("session_before_switch")?.();
      await handlers.get("session_shutdown")?.();
      expect(baseline.invalidate).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists only successful results from active built-in write/edit tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-jscpd-extension-changes-test-"));
    const project = join(root, "project");
    const source = join(project, "src");
    await mkdir(source, { recursive: true });
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const appendEntry = vi.fn();
    const scheduler = createJscpdScanScheduler();
    const markChanged = vi.spyOn(scheduler, "markChanged");
    let editSource = "builtin";
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry,
      getAllTools: () => [
        {
          name: "write",
          sourceInfo: { source: "builtin" },
        },
        {
          name: "edit",
          sourceInfo: { source: editSource },
        },
      ],
      on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;

    try {
      registerJscpdExtension(pi, {
        capabilityService: createCapabilityService().service,
        adapterService: createAdapterService().service,
        configService: createConfigService().service,
        scheduler,
      });
      await handlers.get("session_start")?.(
        { reason: "startup" },
        {
          cwd: project,
          hasUI: false,
          isProjectTrusted: () => true,
          sessionManager: { getBranch: () => [] },
          ui: { notify: vi.fn() },
        },
      );

      await writeFile(join(source, "written.ts"), "written\n");
      await handlers.get("tool_result")?.(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "src/written.ts", content: "private source is ignored" },
          content: [{ type: "text", text: "arbitrary result text is ignored" }],
          details: undefined,
          isError: false,
        },
        { cwd: project },
      );
      expect(appendEntry).toHaveBeenLastCalledWith(JSCPD_SESSION_STATE_TYPE, {
        version: JSCPD_SESSION_STATE_VERSION,
        modeOverride: null,
        lastCheck: { state: "never" },
        changedFiles: ["src/written.ts"],
        acknowledgements: { identityVersion: 1, findings: [] },
      });

      await handlers.get("tool_result")?.(
        { toolName: "write", input: { path: "src/written.ts" }, isError: false },
        { cwd: project },
      );
      await handlers.get("tool_result")?.(
        { toolName: "write", input: { path: "src/failed.ts" }, isError: true },
        { cwd: project },
      );
      editSource = "project-extension";
      await writeFile(join(source, "override.ts"), "override\n");
      await handlers.get("tool_result")?.(
        { toolName: "edit", input: { path: "src/override.ts" }, isError: false },
        { cwd: project },
      );
      expect(appendEntry).toHaveBeenCalledTimes(1);

      editSource = "builtin";
      await handlers.get("tool_result")?.(
        { toolName: "edit", input: { path: "src/override.ts" }, isError: false },
        { cwd: project },
      );
      expect(appendEntry).toHaveBeenLastCalledWith(JSCPD_SESSION_STATE_TYPE, {
        version: JSCPD_SESSION_STATE_VERSION,
        modeOverride: null,
        lastCheck: { state: "never" },
        changedFiles: ["src/override.ts", "src/written.ts"],
        acknowledgements: { identityVersion: 1, findings: [] },
      });
      expect(markChanged).toHaveBeenCalledTimes(3);
      expect(scheduler.snapshot().changedGeneration).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("/jscpd", () => {
  it("keeps the bare command reserved and never dispatches a scan", async () => {
    const { executor, execute } = createExecutor();
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler("   ", context);

    expect(execute).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Bare /jscpd is reserved for a future interactive overlay and does not run a scan.",
      "info",
    );
  });

  it("dispatches explicit scan tokens through the shared boundary", async () => {
    const { executor, execute } = createExecutor();
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler('scan "src/with spaces"', context);

    expect(execute).toHaveBeenCalledWith(
      { command: "scan", args: ["src/with spaces"] },
      { cwd: "/project", signal: undefined },
    );
    expect(notify).toHaveBeenCalledWith("Unavailable in test.", "warning");
  });

  it("dispatches changed through the shared boundary and uses its terminal view", async () => {
    const { executor, execute } = createExecutor(changedResult);
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler("changed", context);

    expect(execute).toHaveBeenCalledWith(
      { command: "changed", args: [] },
      { cwd: "/project", signal: undefined },
    );
    expect(notify).toHaveBeenCalledWith("Terminal changed result in test.", "info");
  });

  it("renders bounded status through the slash command at info level", async () => {
    const { executor, execute } = createExecutor(statusResult);
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler("status", context);

    expect(execute).toHaveBeenCalledWith(
      { command: "status", args: [] },
      { cwd: "/project", signal: undefined },
    );
    expect(notify).toHaveBeenCalledWith("Terminal status in test.", "info");
  });

  it("reports invalid input without reaching execution", async () => {
    const { executor, execute } = createExecutor();
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler("unknown", context);

    expect(execute).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Unsupported jscpd command. Supported commands: scan, changed, status, off, on, help.",
      "error",
    );
  });
});

describe("jscpd_run", () => {
  it("dispatches scan args as an unchanged token array", async () => {
    const { executor, execute } = createExecutor();
    const definition = createJscpdToolDefinition(executor);

    const result = await definition.execute(
      "tool-call",
      { command: "scan", args: ["@src/example.ts", "two words"] },
      undefined,
      undefined,
      toolContext(),
    );

    expect(execute).toHaveBeenCalledWith(
      { command: "scan", args: ["@src/example.ts", "two words"] },
      { cwd: "/project", signal: undefined },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Unavailable in test." }],
      details: unavailableResult,
    });
  });

  it("returns changed content through the same agent-tool path", async () => {
    const { executor, execute } = createExecutor(changedResult);
    const definition = createJscpdToolDefinition(executor);

    const result = await definition.execute(
      "tool-call",
      { command: "changed" },
      undefined,
      undefined,
      toolContext(),
    );

    expect(execute).toHaveBeenCalledWith(
      { command: "changed", args: [] },
      { cwd: "/project", signal: undefined },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Model changed result in test." }],
      details: changedResult,
    });
  });

  it("returns bounded status content through the agent tool", async () => {
    const { executor } = createExecutor(statusResult);
    const definition = createJscpdToolDefinition(executor);

    const result = await definition.execute(
      "tool-call",
      { command: "status" },
      undefined,
      undefined,
      toolContext(),
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Model status in test." }],
      details: statusResult,
    });
  });

  it("validates the explicit project cwd before lazily probing or running a scan", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const capability = createCapabilityService();
    const adapter = createAdapterService();
    const config = createConfigService();
    registerJscpdExtension({ registerTool, registerCommand, on } as unknown as ExtensionAPI, {
      capabilityService: capability.service,
      adapterService: adapter.service,
      configService: config.service,
    });
    const definition = registerTool.mock.calls[0]?.[0] as ReturnType<
      typeof createJscpdToolDefinition
    >;

    const result = await definition.execute(
      "tool-call",
      { command: "scan" },
      undefined,
      undefined,
      toolContext(),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "jscpd scan requires an available project working directory; no scan ran.",
        },
      ],
      details: {
        status: "failed",
        reason: "unsupported-path",
        message: "jscpd scan requires an available project working directory; no scan ran.",
      },
    });
    expect(capability.probe).not.toHaveBeenCalled();
  });
});
