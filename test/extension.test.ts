import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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

describe("Pi extension registration", () => {
  it("registers one jscpd_run tool and one /jscpd command", () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const pi = { registerTool, registerCommand } as unknown as ExtensionAPI;

    registerJscpdExtension(pi);

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

  it("returns the honest default not-implemented outcome", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    registerJscpdExtension({ registerTool, registerCommand } as unknown as ExtensionAPI);
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
          text: "jscpd scan is unavailable: executable integration is not implemented yet.",
        },
      ],
      details: {
        status: "unavailable",
        reason: "not-implemented",
        message: "jscpd scan is unavailable: executable integration is not implemented yet.",
      },
    });
  });
});
