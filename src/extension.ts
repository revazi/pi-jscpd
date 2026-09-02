import type {
  ExtensionAPI,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJscpdCapabilityService, type JscpdCapabilityService } from "./capability.js";
import { createJscpdChangedFileTracker, type JscpdChangedFileTracker } from "./changed-files.js";
import { createJscpdConfigService, type JscpdConfigService } from "./config.js";
import { type jscpdRunParams, jscpdToolContract } from "./contract.js";
import { dispatchJscpdCommand } from "./dispatch.js";
import { createJscpdService, type JscpdService } from "./jscpd.js";
import { parseJscpdSlashArgs } from "./parser.js";
import { getJscpdArgumentCompletions, jscpdArgumentHint } from "./registry.js";
import { createJscpdScanExecutor } from "./scan.js";
import {
  JSCPD_SESSION_STATE_TYPE,
  restoreJscpdSessionState,
  snapshotJscpdSessionState,
} from "./session-state.js";
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
  let shutdownPromise: Promise<void> | undefined;
  let persistSessionState = () => {};
  const changedFiles = createJscpdChangedFileTracker();
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
    persistSessionState = () => {
      if (!sessionMode || !statusService) return;
      try {
        pi.appendEntry(
          JSCPD_SESSION_STATE_TYPE,
          snapshotJscpdSessionState(sessionMode, statusService, changedFiles),
        );
      } catch {
        // Pi session persistence is advisory and must not break scans or controls.
      }
    };
    executor = createJscpdStatusAwareExecutor(
      scanExecutor,
      statusService,
      sessionMode,
      persistSessionState,
    );
  }

  pi.registerTool(createJscpdToolDefinition(executor));
  pi.registerCommand("jscpd", createJscpdSlashCommandDefinition(executor));

  pi.on("session_start", async (_event, ctx) => {
    capabilityService?.invalidate();
    adapterService.invalidate();
    const loaded = await configService.load({
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
    });
    await restoreSessionState(
      ctx.sessionManager.getBranch(),
      ctx.cwd,
      loaded.config.enabled,
      changedFiles,
      sessionMode,
      statusService,
    );
    if (ctx.hasUI) {
      for (const diagnostic of loaded.diagnostics) {
        ctx.ui.notify(diagnostic.message, "warning");
      }
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    adapterService.invalidate();
    await restoreSessionState(
      ctx.sessionManager.getBranch(),
      ctx.cwd,
      configService.current().config.enabled,
      changedFiles,
      sessionMode,
      statusService,
    );
  });
  pi.on("session_before_switch", () => {
    changedFiles.reset();
    capabilityService?.invalidate();
    adapterService.invalidate();
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!isBuiltInMutationTool(pi, event.toolName)) return;
    try {
      if (await changedFiles.recordToolResult(event, ctx.cwd)) persistSessionState();
    } catch {
      // Changed-file attribution is advisory and must not affect tool completion.
    }
  });
  pi.on("session_shutdown", () => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      capabilityService?.dispose();
      await adapterService.dispose();
    });
    return shutdownPromise;
  });
}

async function restoreSessionState(
  activeBranch: readonly unknown[],
  cwd: string,
  configuredEnabled: boolean,
  changedFiles: JscpdChangedFileTracker,
  sessionMode?: JscpdSessionModeService,
  statusService?: JscpdStatusService,
): Promise<void> {
  const restored = restoreJscpdSessionState(activeBranch);
  await changedFiles.start(cwd, restored?.changedFiles);
  if (!sessionMode || !statusService) return;
  sessionMode.restore(configuredEnabled, restored?.modeOverride);
  statusService.restore(restored?.lastCheck);
}

function isBuiltInMutationTool(pi: ExtensionAPI, toolName: string): boolean {
  if (toolName !== "edit" && toolName !== "write") return false;
  try {
    const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
    return tool?.sourceInfo.source === "builtin";
  } catch {
    return false;
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
