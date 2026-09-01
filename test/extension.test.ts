import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { JscpdCapabilityService } from "../src/capability.js";
import type { JscpdConfigService } from "../src/config.js";
import {
  createJscpdSlashCommandDefinition,
  createJscpdToolDefinition,
  registerJscpdExtension,
} from "../src/extension.js";
import type { JscpdService } from "../src/jscpd.js";
import { jscpdArgumentHint } from "../src/registry.js";
import type { JscpdCommandExecutor } from "../src/types.js";

const unavailableResult = {
  status: "unavailable",
  reason: "missing-binary",
  message: "Unavailable in test.",
} as const;

function createExecutor() {
  const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => unavailableResult);
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
      "session_before_switch",
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
    registerJscpdExtension(
      {
        registerTool,
        registerCommand: vi.fn(),
        on: vi.fn(),
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
    });
    await handlers.get("session_start")?.(
      {},
      {
        cwd: "/project",
        hasUI: true,
        isProjectTrusted: () => true,
        ui: { notify },
      },
    );
    await handlers.get("session_before_switch")?.();
    await handlers.get("session_shutdown")?.();

    expect(config.load).toHaveBeenCalledWith({ cwd: "/project", trusted: true });
    expect(notify).toHaveBeenCalledWith("Invalid project configuration.", "warning");
    expect(capability.invalidate).toHaveBeenCalledTimes(2);
    expect(capability.dispose).toHaveBeenCalledOnce();
    expect(adapter.invalidate).toHaveBeenCalledTimes(2);
    expect(adapter.dispose).toHaveBeenCalledOnce();
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

  it("reports invalid input without reaching execution", async () => {
    const { executor, execute } = createExecutor();
    const definition = createJscpdSlashCommandDefinition(executor);
    const { context, notify } = commandContext();

    await definition.handler("changed", context);

    expect(execute).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Unsupported jscpd command. Supported commands: scan.",
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
