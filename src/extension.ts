import type {
  ExtensionAPI,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJscpdCapabilityService, type JscpdCapabilityService } from "./capability.js";
import { createJscpdConfigService, type JscpdConfigService } from "./config.js";
import { type jscpdRunParams, jscpdToolContract } from "./contract.js";
import { dispatchJscpdCommand } from "./dispatch.js";
import { createJscpdService, type JscpdService } from "./jscpd.js";
import { parseJscpdSlashArgs } from "./parser.js";
import { getJscpdArgumentCompletions, jscpdArgumentHint } from "./registry.js";
import { createJscpdScanExecutor } from "./scan.js";
import {
  createJscpdSessionModeService,
  createJscpdStatusAwareExecutor,
  createJscpdStatusService,
  type JscpdSessionModeService,
  type JscpdStatusService,
} from "./status.js";
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
  adapterService?: JscpdService;
  configService?: JscpdConfigService;
}

export function registerJscpdExtension(
  pi: ExtensionAPI,
  options: JscpdExtensionOptions = {},
): void {
  let capabilityService = options.capabilityService;
  let executor = options.executor;
  let statusService: JscpdStatusService | undefined;
  let sessionMode: JscpdSessionModeService | undefined;
  const adapterService = options.adapterService ?? createJscpdService();
  const configService = options.configService ?? createJscpdConfigService();
  if (!executor) {
    capabilityService ??= createJscpdCapabilityService();
    sessionMode = createJscpdSessionModeService();
    const scanExecutor = createJscpdScanExecutor(capabilityService, adapterService, {
      config: () => ({
        ...configService.current().config,
        enabled: sessionMode?.isEnabled() ?? true,
      }),
    });
    statusService = createJscpdStatusService(capabilityService, configService, sessionMode);
    executor = createJscpdStatusAwareExecutor(scanExecutor, statusService, sessionMode);
  }

  pi.registerTool(createJscpdToolDefinition(executor));
  pi.registerCommand("jscpd", createJscpdSlashCommandDefinition(executor));

  pi.on("session_start", async (_event, ctx) => {
    capabilityService?.invalidate();
    adapterService.invalidate();
    statusService?.reset();
    const loaded = await configService.load({
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
    });
    sessionMode?.reset(loaded.config.enabled);
    if (ctx.hasUI) {
      for (const diagnostic of loaded.diagnostics) {
        ctx.ui.notify(diagnostic.message, "warning");
      }
    }
  });
  pi.on("session_before_switch", () => {
    capabilityService?.invalidate();
    adapterService.invalidate();
  });
  pi.on("session_shutdown", async () => {
    capabilityService?.dispose();
    await adapterService.dispose();
  });
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
    description: "Run or inspect jscpd. Bare /jscpd is reserved for a future overlay.",
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
      ctx.ui.notify(terminalResultMessage(result), resultNotificationLevel(result));
    },
  };
}

function terminalResultMessage(result: JscpdDispatchResult): string {
  switch (result.status) {
    case "completed":
    case "status":
    case "control":
    case "help":
      return result.terminalMessage;
    default:
      return result.message;
  }
}

function resultNotificationLevel(result: JscpdDispatchResult): "info" | "warning" | "error" {
  switch (result.status) {
    case "completed":
    case "status":
    case "control":
    case "help":
      return "info";
    case "invalid":
    case "error":
      return "error";
    default:
      return "warning";
  }
}
