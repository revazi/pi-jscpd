import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { JscpdCapabilityService } from "../src/capability.js";
import {
  createJscpdSlashCommandDefinition,
  createJscpdToolDefinition,
  registerJscpdExtension,
} from "../src/extension.js";
import { jscpdArgumentHint } from "../src/registry.js";
import type { JscpdCommandExecutor } from "../src/types.js";

const unavailableResult = {
  status: "unavailable",
  reason: "not-implemented",
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

    registerJscpdExtension(pi, { capabilityService: capability.service });

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

  it("invalidates or disposes capability state at session boundaries", () => {
    const handlers = new Map<string, () => void>();
    const capability = createCapabilityService();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;

    registerJscpdExtension(pi, { capabilityService: capability.service });
    handlers.get("session_start")?.();
    handlers.get("session_before_switch")?.();
    handlers.get("session_shutdown")?.();

    expect(capability.invalidate).toHaveBeenCalledTimes(2);
    expect(capability.dispose).toHaveBeenCalledOnce();
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

  it("lazily reports a detected executable while keeping scan execution honest", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const capability = createCapabilityService();
    registerJscpdExtension({ registerTool, registerCommand, on } as unknown as ExtensionAPI, {
      capabilityService: capability.service,
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
          text: "jscpd scan execution is not implemented yet (detected jscpd v5.1.0).",
        },
      ],
      details: {
        status: "unavailable",
        reason: "not-implemented",
        message: "jscpd scan execution is not implemented yet (detected jscpd v5.1.0).",
        capability: {
          status: "available",
          executable: "jscpd",
          version: "5.1.0",
          major: 5,
        },
      },
    });
    expect(capability.probe).toHaveBeenCalledWith({ cwd: "/project", signal: undefined });
  });
});
