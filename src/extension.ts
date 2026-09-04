import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { createJscpdAcknowledgementTracker } from "./acknowledgements.js";
import {
  boundedJscpdAutomaticFindingLimit,
  createJscpdAutomaticAcknowledgementTransaction,
  createJscpdAutomaticCheck,
  createJscpdAutomaticResultEffectActions,
  handleJscpdAutomaticResult,
  handleJscpdAutomaticResultEffect,
  JSCPD_AUTOMATIC_MESSAGE_TYPE,
  JSCPD_AUTOMATIC_STATUS_KEY,
  type JscpdAutomaticAcknowledgementTransaction,
  type JscpdAutomaticCheck,
  type JscpdAutomaticResultActions,
} from "./automatic.js";
import {
  createJscpdBaselineService,
  type JscpdBaselineService,
  type JscpdBaselineStartContext,
} from "./baseline.js";
import { createJscpdCapabilityService, type JscpdCapabilityService } from "./capability.js";
import { createJscpdChangedExecutor } from "./changed.js";
import { createJscpdChangedFileTracker, type JscpdChangedFileTracker } from "./changed-files.js";
import { createJscpdConfigService, type JscpdConfigService } from "./config.js";
import { type jscpdRunParams, jscpdToolContract } from "./contract.js";
import { dispatchJscpdCommand } from "./dispatch.js";
import {
  createJscpdManagedRuntime,
  type JscpdEffectRuntime,
  JscpdTestEffectRuntime,
} from "./effect/runtime-boundary.js";
import {
  createJscpdFallowCoexistenceService,
  type JscpdFallowCoexistenceService,
} from "./fallow.js";
import { createJscpdService, type JscpdService } from "./jscpd.js";
import { createJscpdOverlayLauncher, type JscpdOverlayLauncher } from "./overlay.js";
import { parseJscpdSlashArgs } from "./parser.js";
import { getJscpdArgumentCompletions, jscpdArgumentHint } from "./registry.js";
import { createJscpdScanExecutor } from "./scan.js";
import {
  createJscpdScanScheduler,
  createJscpdScheduledExecutor,
  type JscpdScanScheduler,
} from "./scheduler.js";
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
import { createJscpdVerificationService, type JscpdVerificationService } from "./verification.js";

type JscpdToolDefinition = ToolDefinition<typeof jscpdRunParams, JscpdDispatchResult>;

type JscpdSlashCommandDefinition = Omit<RegisteredCommand, "name" | "sourceInfo"> & {
  argumentHint: string;
};

export interface JscpdExtensionOptions {
  /** Isolated host seam for runtime lifecycle tests; production creates one managed runtime. */
  runtime?: JscpdEffectRuntime;
  executor?: JscpdCommandExecutor;
  capabilityService?: JscpdCapabilityService;
  adapterService?: JscpdService;
  configService?: JscpdConfigService;
  baselineService?: JscpdBaselineService;
  scheduler?: JscpdScanScheduler;
  automaticCheck?: JscpdAutomaticCheck;
  overlayLauncher?: JscpdOverlayLauncher;
  verificationService?: JscpdVerificationService;
  fallowCoexistenceService?: JscpdFallowCoexistenceService;
}

export function registerJscpdExtension(
  pi: ExtensionAPI,
  options: JscpdExtensionOptions = {},
): void {
  const runtime = options.runtime ?? createJscpdManagedRuntime();
  let capabilityService = options.capabilityService;
  let executor = options.executor;
  let statusService: JscpdStatusService | undefined;
  let sessionMode: JscpdSessionModeService | undefined;
  let baselineService = options.baselineService;
  let automaticCheck = options.automaticCheck;
  let verificationService = options.verificationService;
  let automaticAcknowledgements: JscpdAutomaticAcknowledgementTransaction | undefined;
  let baselineContext: JscpdBaselineStartContext | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let persistSessionState = () => {};
  const changedFiles = createJscpdChangedFileTracker();
  const acknowledgements = createJscpdAcknowledgementTracker();
  const scheduler = options.scheduler ?? createJscpdScanScheduler(runtime);
  const adapterService = options.adapterService ?? createJscpdService();
  const configService = options.configService ?? createJscpdConfigService();
  const fallowCoexistence =
    options.fallowCoexistenceService ?? createJscpdFallowCoexistenceService();
  if (!executor) {
    capabilityService ??= createJscpdCapabilityService(undefined, runtime);
    verificationService ??= createJscpdVerificationService();
    sessionMode = createJscpdSessionModeService();
    const scanExecutor = createJscpdScanExecutor(
      capabilityService,
      adapterService,
      {
        config: () => ({
          ...configService.current().config,
          enabled: sessionMode?.isEnabled() ?? true,
        }),
        verification: verificationService,
      },
      runtime,
    );
    statusService = createJscpdStatusService(
      capabilityService,
      configService,
      sessionMode,
      fallowCoexistence,
      runtime,
    );
    baselineService ??= createJscpdBaselineService(capabilityService, adapterService);
    persistSessionState = () => {
      if (!sessionMode || !statusService) return;
      try {
        pi.appendEntry(
          JSCPD_SESSION_STATE_TYPE,
          snapshotJscpdSessionState(sessionMode, statusService, changedFiles, acknowledgements),
        );
      } catch {
        // Pi session persistence is advisory and must not break scans or controls.
      }
    };
    const changedOptions = {
      config: () => ({
        ...configService.current().config,
        enabled: sessionMode?.isEnabled() ?? true,
      }),
      verification: verificationService,
    };
    const changedExecutor = createJscpdChangedExecutor(
      capabilityService,
      adapterService,
      baselineService,
      changedFiles,
      acknowledgements,
      changedOptions,
      runtime,
    );
    automaticAcknowledgements = createJscpdAutomaticAcknowledgementTransaction(acknowledgements);
    automaticCheck ??= createJscpdAutomaticCheck(
      createJscpdChangedExecutor(
        capabilityService,
        adapterService,
        baselineService,
        changedFiles,
        automaticAcknowledgements.tracker,
        {
          config: () => {
            const config = changedOptions.config();
            return {
              ...config,
              maxFindings: boundedJscpdAutomaticFindingLimit(config.maxFindings),
            };
          },
          prioritizeFindings: true,
        },
        runtime,
      ),
      { beforeRun: automaticAcknowledgements.discard },
      runtime,
    );
    executor = createJscpdStatusAwareExecutor(
      scanExecutor,
      statusService,
      sessionMode,
      () => {
        persistSessionState();
        synchronizeBaselineMode(runtime, baselineService, baselineContext, sessionMode);
      },
      changedExecutor,
      runtime,
    );
  }
  executor = createJscpdScheduledExecutor(executor, scheduler, runtime);
  const overlayLauncher =
    options.overlayLauncher ??
    createJscpdOverlayLauncher(executor, { changedFileCount: () => changedFiles.files().length });

  pi.registerTool(createJscpdToolDefinition(executor, runtime));
  pi.registerCommand(
    "jscpd",
    createJscpdSlashCommandDefinition(executor, overlayLauncher, runtime),
  );

  pi.on("session_start", async (_event, ctx) => {
    scheduler.reset();
    fallowCoexistence.reset();
    verificationService?.reset();
    baselineService?.invalidate();
    capabilityService?.invalidate();
    adapterService.invalidate();
    const trusted = ctx.isProjectTrusted();
    const loaded = await runtime.runPromise(configService.loadEffect({ cwd: ctx.cwd, trusted }));
    await runtime.runPromise(
      fallowCoexistence.evaluateEffect({
        cwd: ctx.cwd,
        trusted,
        policy: loaded.config.fallowCoexistence,
        fallowToolAvailable: hasFallowTool(pi),
      }),
    );
    await restoreSessionState(
      runtime,
      ctx.sessionManager.getBranch(),
      ctx.cwd,
      loaded.config.enabled,
      changedFiles,
      acknowledgements,
      sessionMode,
      statusService,
    );
    baselineContext = createBaselineContext(
      ctx.cwd,
      loaded.config.timeoutMs,
      changedFiles,
      sessionMode,
    );
    startBaselineQuietly(runtime, baselineService, baselineContext);
    if (ctx.hasUI) {
      safeSetStatus(ctx.ui, undefined);
      for (const diagnostic of loaded.diagnostics) {
        ctx.ui.notify(diagnostic.message, "warning");
      }
      const overlapNotice = fallowCoexistence.takeNotice();
      if (overlapNotice) ctx.ui.notify(overlapNotice, "info");
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    scheduler.reset();
    verificationService?.reset();
    baselineService?.invalidate();
    adapterService.invalidate();
    const config = configService.current().config;
    await runtime.runPromise(
      fallowCoexistence.evaluateEffect({
        cwd: ctx.cwd,
        trusted: configService.current().trusted,
        policy: config.fallowCoexistence,
        fallowToolAvailable: hasFallowTool(pi),
      }),
    );
    await restoreSessionState(
      runtime,
      ctx.sessionManager.getBranch(),
      ctx.cwd,
      config.enabled,
      changedFiles,
      acknowledgements,
      sessionMode,
      statusService,
    );
    baselineContext = createBaselineContext(ctx.cwd, config.timeoutMs, changedFiles, sessionMode);
    startBaselineQuietly(runtime, baselineService, baselineContext);
    if (ctx.hasUI) {
      safeSetStatus(ctx.ui, undefined);
      const overlapNotice = fallowCoexistence.takeNotice();
      if (overlapNotice) ctx.ui.notify(overlapNotice, "info");
    }
  });
  pi.on("session_before_switch", () => {
    scheduler.reset();
    fallowCoexistence.reset();
    verificationService?.reset();
    baselineContext = undefined;
    baselineService?.invalidate();
    changedFiles.reset();
    acknowledgements.reset();
    capabilityService?.invalidate();
    adapterService.invalidate();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    scheduler.cancelAutomatic();
    const snapshot = scheduler.snapshot();
    if (ctx.hasUI && snapshot.changedGeneration > snapshot.attemptedGeneration) {
      safeSetStatus(ctx.ui, pendingAutomaticStatus(fallowCoexistence));
    }
  });
  pi.on("tool_call", async (event) => {
    if (!isBuiltInMutationTool(pi, event.toolName)) return;
    if (baselineService) await runtime.runPromise(baselineService.waitEffect);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!isBuiltInMutationTool(pi, event.toolName)) return;
    try {
      const previouslyTracked = new Set(changedFiles.files());
      const path = await runtime.runPromise(
        changedFiles.recordToolResultPathEffect(event, ctx.cwd),
      );
      if (path) {
        scheduler.markChanged();
        if (ctx.hasUI) safeSetStatus(ctx.ui, pendingAutomaticStatus(fallowCoexistence));
        const acknowledgementChanged = acknowledgements.invalidatePaths([path]);
        baselineContext = baselineContext
          ? Object.freeze({ ...baselineContext, hasPriorChanges: true })
          : undefined;
        if (!previouslyTracked.has(path) || acknowledgementChanged) persistSessionState();
      }
    } catch {
      // Changed-file attribution is advisory and must not affect tool completion.
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (
      !automaticCheck ||
      !fallowCoexistence.automaticAllowed() ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      return;
    requestAutomaticCheck(
      pi,
      ctx,
      scheduler,
      automaticCheck,
      automaticAcknowledgements,
      statusService,
      persistSessionState,
    );
  });
  pi.on("session_shutdown", () => {
    baselineContext = undefined;
    fallowCoexistence.reset();
    verificationService?.reset();
    baselineService?.invalidate();
    shutdownPromise ??= Promise.resolve().then(async () => {
      try {
        await scheduler.dispose();
        capabilityService?.dispose();
        await runtime.runPromise(adapterService.disposeEffect());
      } finally {
        await runtime.dispose();
      }
    });
    return shutdownPromise;
  });
}

function requestAutomaticCheck(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  scheduler: JscpdScanScheduler,
  automaticCheck: JscpdAutomaticCheck,
  acknowledgements: JscpdAutomaticAcknowledgementTransaction | undefined,
  status: JscpdStatusService | undefined,
  persist: () => void,
): void {
  const cwd = ctx.cwd;
  if (scheduler.requestAutomaticEffect && automaticCheck.runEffect) {
    scheduler.requestAutomaticEffect(({ signal, isCurrent }) => {
      const actions = createAutomaticDeliveryActions(
        pi,
        ctx,
        isCurrent,
        acknowledgements,
        status,
        persist,
      );
      return Effect.sync(() => setAutomaticCheckingStatus(ctx, isCurrent)).pipe(
        Effect.zipRight(
          automaticCheck.runEffect?.({
            cwd,
            signal,
            isCurrent,
            onResult: actions
              ? (result) =>
                  handleJscpdAutomaticResultEffect(
                    result,
                    createJscpdAutomaticResultEffectActions(actions),
                  )
              : undefined,
          }) ?? Effect.succeed("deferred" as const),
        ),
        Effect.tap((disposition) =>
          Effect.sync(() => restoreDeferredAutomaticStatus(ctx, isCurrent, disposition)),
        ),
      );
    });
    return;
  }

  scheduler.requestAutomatic(async ({ signal, isCurrent }) => {
    setAutomaticCheckingStatus(ctx, isCurrent);
    const actions = createAutomaticDeliveryActions(
      pi,
      ctx,
      isCurrent,
      acknowledgements,
      status,
      persist,
    );
    const disposition = await automaticCheck.run({
      cwd,
      signal,
      isCurrent,
      onResult: actions ? (result) => handleJscpdAutomaticResult(result, actions) : undefined,
    });
    restoreDeferredAutomaticStatus(ctx, isCurrent, disposition);
    return disposition;
  });
}

function createAutomaticDeliveryActions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  isCurrent: () => boolean,
  acknowledgements: JscpdAutomaticAcknowledgementTransaction | undefined,
  status: JscpdStatusService | undefined,
  persist: () => void,
): JscpdAutomaticResultActions | undefined {
  if (!acknowledgements || !status) return undefined;
  return {
    isCurrent,
    isIdle: () => ctx.isIdle(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    acknowledgements,
    sendFinding(content, details) {
      pi.sendMessage(
        {
          customType: JSCPD_AUTOMATIC_MESSAGE_TYPE,
          content,
          display: ctx.hasUI,
          details,
        },
        { triggerTurn: false },
      );
    },
    record: (result) => status.record(result),
    persist,
    setStatus: ctx.hasUI ? (text) => safeSetStatus(ctx.ui, text) : undefined,
  };
}

function setAutomaticCheckingStatus(ctx: ExtensionContext, isCurrent: () => boolean): void {
  if (ctx.hasUI && isCurrent() && ctx.isIdle() && !ctx.hasPendingMessages()) {
    safeSetStatus(ctx.ui, "jscpd: checking changes…");
  }
}

function restoreDeferredAutomaticStatus(
  ctx: ExtensionContext,
  isCurrent: () => boolean,
  disposition: "attempted" | "deferred",
): void {
  if (
    disposition === "deferred" &&
    ctx.hasUI &&
    isCurrent() &&
    ctx.isIdle() &&
    !ctx.hasPendingMessages()
  ) {
    safeSetStatus(ctx.ui, "jscpd: changes pending");
  }
}

function safeSetStatus(
  ui: { setStatus(key: string, text: string | undefined): void },
  text: string | undefined,
): void {
  try {
    ui.setStatus(JSCPD_AUTOMATIC_STATUS_KEY, text);
  } catch {
    // Footer status is optional and must not affect scans or lifecycle cleanup.
  }
}

function createBaselineContext(
  cwd: string,
  timeoutMs: number,
  changedFiles: JscpdChangedFileTracker,
  sessionMode?: JscpdSessionModeService,
): JscpdBaselineStartContext {
  return Object.freeze({
    cwd,
    enabled: sessionMode?.isEnabled() ?? true,
    timeoutMs,
    hasPriorChanges: changedFiles.files().length > 0,
  });
}

function startBaselineQuietly(
  runtime: JscpdEffectRuntime,
  baselineService: JscpdBaselineService | undefined,
  context: JscpdBaselineStartContext,
): void {
  if (baselineService) void runtime.runPromiseExit(baselineService.startEffect(context));
}

function synchronizeBaselineMode(
  runtime: JscpdEffectRuntime,
  baselineService: JscpdBaselineService | undefined,
  context: JscpdBaselineStartContext | undefined,
  sessionMode: JscpdSessionModeService | undefined,
): void {
  if (!baselineService || !context || !sessionMode) return;
  if (!sessionMode.isEnabled()) {
    baselineService.disable();
    return;
  }
  const current = baselineService.current();
  if (
    current.status === "unstarted" ||
    (current.status === "unavailable" && current.reason === "disabled")
  ) {
    startBaselineQuietly(runtime, baselineService, {
      ...context,
      enabled: true,
      hasPriorChanges: context.hasPriorChanges,
    });
  }
}

async function restoreSessionState(
  runtime: JscpdEffectRuntime,
  activeBranch: readonly unknown[],
  cwd: string,
  configuredEnabled: boolean,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: ReturnType<typeof createJscpdAcknowledgementTracker>,
  sessionMode?: JscpdSessionModeService,
  statusService?: JscpdStatusService,
): Promise<void> {
  const restored = restoreJscpdSessionState(activeBranch);
  await runtime.runPromise(changedFiles.startEffect(cwd, restored?.changedFiles));
  acknowledgements.restore(restored?.acknowledgements);
  if (!sessionMode || !statusService) return;
  sessionMode.restore(configuredEnabled, restored?.modeOverride);
  statusService.restore(restored?.lastCheck);
}

function hasFallowTool(pi: ExtensionAPI): boolean {
  try {
    return pi.getAllTools().some(({ name }) => name === "fallow_run");
  } catch {
    return false;
  }
}

function pendingAutomaticStatus(coexistence: JscpdFallowCoexistenceService): string {
  if (coexistence.automaticAllowed()) return "jscpd: changes pending";
  return coexistence.current().status === "detected"
    ? "jscpd: on demand (Fallow overlap)"
    : "jscpd: automatic checks on demand";
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

export function createJscpdToolDefinition(
  executor: JscpdCommandExecutor,
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdToolDefinition {
  return {
    ...jscpdToolContract,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await dispatchJscpdCommand(
        params.command,
        params.args,
        { cwd: ctx.cwd, signal: signal ?? ctx.signal },
        executor,
        runtime,
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
  overlayLauncher: JscpdOverlayLauncher = createJscpdOverlayLauncher(executor),
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdSlashCommandDefinition {
  return {
    description: "Open the jscpd overview or run an explicit subcommand.",
    argumentHint: jscpdArgumentHint,
    getArgumentCompletions: getJscpdArgumentCompletions,
    async handler(rawArgs, ctx) {
      const parsed = parseJscpdSlashArgs(rawArgs);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error.message, "error");
        return;
      }
      if (parsed.kind === "bare") {
        try {
          await overlayLauncher.open(ctx);
        } catch {
          ctx.ui.notify(
            "The jscpd overview could not open; explicit subcommands remain available.",
            "warning",
          );
        }
        return;
      }

      const result = await dispatchJscpdCommand(
        parsed.invocation.command,
        parsed.invocation.args,
        { cwd: ctx.cwd, signal: ctx.signal },
        executor,
        runtime,
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
    case "changed":
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
    case "changed":
      return "info";
    case "invalid":
    case "error":
      return "error";
    default:
      return "warning";
  }
}
