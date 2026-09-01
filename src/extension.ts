import type {
  ExtensionAPI,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJscpdCapabilityService, type JscpdCapabilityService } from "./capability.js";
import { type jscpdRunParams, jscpdToolContract } from "./contract.js";
import { createCapabilityAwareJscpdExecutor, dispatchJscpdCommand } from "./dispatch.js";
import { parseJscpdSlashArgs } from "./parser.js";
import { getJscpdArgumentCompletions, jscpdArgumentHint } from "./registry.js";
import type { JscpdCommandExecutor, JscpdDispatchResult } from "./types.js";

const BARE_COMMAND_MESSAGE =
  "Bare /jscpd is reserved for a future interactive overlay and does not run a scan.";

type JscpdToolDefinition = ToolDefinition<typeof jscpdRunParams, JscpdDispatchResult>;

type JscpdSlashCommandDefinition = Omit<RegisteredCommand, "name" | "sourceInfo"> & {
  argumentHint: string;
};

export interface JscpdExtensionOptions {
  executor?: JscpdCommandExecutor;
  capabilityService?: JscpdCapabilityService;
}

export function registerJscpdExtension(
  pi: ExtensionAPI,
  options: JscpdExtensionOptions = {},
): void {
  let capabilityService = options.capabilityService;
  let executor = options.executor;
  if (!executor) {
    capabilityService ??= createJscpdCapabilityService();
    executor = createCapabilityAwareJscpdExecutor(capabilityService);
  }

  pi.registerTool(createJscpdToolDefinition(executor));
  pi.registerCommand("jscpd", createJscpdSlashCommandDefinition(executor));

  if (capabilityService) {
    pi.on("session_start", () => capabilityService.invalidate());
    pi.on("session_before_switch", () => capabilityService.invalidate());
    pi.on("session_shutdown", () => capabilityService.dispose());
  }
}

export function createJscpdToolDefinition(executor: JscpdCommandExecutor): JscpdToolDefinition {
  return {
    ...jscpdToolContract,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await dispatchJscpdCommand(
        params.command,
        params.args,
        { cwd: ctx.cwd, signal: signal ?? ctx.signal },
        executor,
      );
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  };
}

export function createJscpdSlashCommandDefinition(
  executor: JscpdCommandExecutor,
): JscpdSlashCommandDefinition {
  return {
    description: "Request an explicit jscpd scan. Bare /jscpd is reserved for a future overlay.",
    argumentHint: jscpdArgumentHint,
    getArgumentCompletions: getJscpdArgumentCompletions,
    async handler(rawArgs, ctx) {
      const parsed = parseJscpdSlashArgs(rawArgs);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error.message, "error");
        return;
      }
      if (parsed.kind === "bare") {
        ctx.ui.notify(BARE_COMMAND_MESSAGE, "info");
        return;
      }

      const result = await dispatchJscpdCommand(
        parsed.invocation.command,
        parsed.invocation.args,
        { cwd: ctx.cwd, signal: ctx.signal },
        executor,
      );
      ctx.ui.notify(result.message, result.status === "unavailable" ? "warning" : "error");
    },
  };
}
