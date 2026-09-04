import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, MutableRef } from "effect";
import type { JscpdCapabilityResult, JscpdCapabilityService } from "./capability.js";
import type { JscpdConfigLoadResult, JscpdConfigService, JscpdConfigSource } from "./config.js";
import {
  type JscpdEffectRuntime,
  type JscpdRuntimeRequirements,
  JscpdTestEffectRuntime,
} from "./effect/runtime-boundary.js";
import type { JscpdProcess } from "./effect/services.js";
import type { JscpdFallowCoexistenceService } from "./fallow.js";
import { renderJscpdCommandHelp } from "./registry.js";
import { capabilityProbeEffect } from "./scan.js";
import type {
  JscpdCommandExecutor,
  JscpdExecutionContext,
  JscpdExecutionResult,
  JscpdLastCheck,
  JscpdStatusResult,
} from "./types.js";

export interface JscpdStatusService {
  inspect(context: JscpdExecutionContext): Promise<JscpdStatusResult>;
  inspectEffect?: (
    context: JscpdExecutionContext,
  ) => Effect.Effect<JscpdStatusResult, never, JscpdProcess>;
  record(result: JscpdExecutionResult, expectedScope?: number): void;
  recordEffect?: (result: JscpdExecutionResult, expectedScope?: number) => Effect.Effect<void>;
  restore(lastCheck?: JscpdLastCheck): void;
  lastCheck(): JscpdLastCheck;
  /** Lifecycle generation used to reject results from a superseded branch. */
  scope?(): number;
  readonly scopeEffect?: Effect.Effect<number>;
}

export interface JscpdSessionModeService {
  isEnabled(): boolean;
  source(): "configuration" | "session";
  override(): "enabled" | "disabled" | null;
  restore(configuredEnabled: boolean, override?: "enabled" | "disabled" | null): void;
  enable(): void;
  disable(): void;
}

interface SessionModeState {
  readonly enabled: boolean;
  readonly source: "configuration" | "session";
  readonly modeOverride: "enabled" | "disabled" | null;
}

interface JscpdSessionModeEffectService {
  readonly isEnabled: Effect.Effect<boolean>;
  readonly source: Effect.Effect<"configuration" | "session">;
  readonly override: Effect.Effect<"enabled" | "disabled" | null>;
  readonly restore: (
    configuredEnabled: boolean,
    override?: "enabled" | "disabled" | null,
  ) => Effect.Effect<void>;
  readonly enable: Effect.Effect<void>;
  readonly disable: Effect.Effect<void>;
}

export const JscpdSessionMode = Context.GenericTag<JscpdSessionModeEffectService>(
  "pi-jscpd/effect/SessionMode",
);

interface JscpdStatusWorkflowService {
  readonly inspect: (
    context: JscpdExecutionContext,
  ) => Effect.Effect<JscpdStatusResult, never, JscpdProcess>;
  readonly record: (result: JscpdExecutionResult, expectedScope?: number) => Effect.Effect<void>;
  readonly restore: (lastCheck?: JscpdLastCheck) => Effect.Effect<void>;
  readonly lastCheck: Effect.Effect<JscpdLastCheck>;
  readonly scope: Effect.Effect<number>;
}

export const JscpdStatusWorkflow = Context.GenericTag<JscpdStatusWorkflowService>(
  "pi-jscpd/effect/StatusWorkflow",
);

export function createJscpdSessionModeService(): JscpdSessionModeService {
  return sessionModeServiceFor(new SessionModeOwner());
}

export function createJscpdSessionModeLayer(
  service: JscpdSessionModeService = createJscpdSessionModeService(),
) {
  return Layer.succeed(JscpdSessionMode, {
    isEnabled: Effect.sync(() => service.isEnabled()),
    source: Effect.sync(() => service.source()),
    override: Effect.sync(() => service.override()),
    restore: (configuredEnabled, override) =>
      Effect.sync(() => service.restore(configuredEnabled, override)),
    enable: Effect.sync(() => service.enable()),
    disable: Effect.sync(() => service.disable()),
  });
}

class SessionModeOwner {
  readonly #state = MutableRef.make<SessionModeState>({
    enabled: true,
    source: "configuration",
    modeOverride: null,
  });

  isEnabled(): boolean {
    return MutableRef.get(this.#state).enabled;
  }

  source(): "configuration" | "session" {
    return MutableRef.get(this.#state).source;
  }

  override(): "enabled" | "disabled" | null {
    return MutableRef.get(this.#state).modeOverride;
  }

  restore(
    configuredEnabled: boolean,
    restoredOverride: "enabled" | "disabled" | null = null,
  ): void {
    MutableRef.set(this.#state, {
      modeOverride: restoredOverride,
      enabled: restoredOverride === null ? configuredEnabled : restoredOverride === "enabled",
      source: restoredOverride === null ? "configuration" : "session",
    });
  }

  enable(): void {
    MutableRef.set(this.#state, { enabled: true, source: "session", modeOverride: "enabled" });
  }

  disable(): void {
    MutableRef.set(this.#state, { enabled: false, source: "session", modeOverride: "disabled" });
  }
}

function sessionModeServiceFor(owner: SessionModeOwner): JscpdSessionModeService {
  return {
    isEnabled: () => owner.isEnabled(),
    source: () => owner.source(),
    override: () => owner.override(),
    restore: (configuredEnabled, override) => owner.restore(configuredEnabled, override),
    enable: () => owner.enable(),
    disable: () => owner.disable(),
  };
}

/** Route all registered commands while retaining bounded session status. */
export function createJscpdStatusAwareExecutor(
  scanExecutor: JscpdCommandExecutor,
  statusService: JscpdStatusService,
  sessionMode: JscpdSessionModeService,
  stateChanged: () => void = () => {},
  changedExecutor: JscpdCommandExecutor = scanExecutor,
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdCommandExecutor {
  const executeEffect = (
    invocation: Parameters<JscpdCommandExecutor["execute"]>[0],
    context: Parameters<JscpdCommandExecutor["execute"]>[1],
  ) =>
    statusAwareExecutionEffect(
      invocation,
      context,
      scanExecutor,
      changedExecutor,
      statusService,
      sessionMode,
      stateChanged,
    );
  return {
    execute: (invocation, context) => runtime.runPromise(executeEffect(invocation, context)),
    executeEffect,
  };
}

export function createJscpdStatusService(
  capabilityService: JscpdCapabilityService,
  configService: JscpdConfigService,
  sessionMode: JscpdSessionModeService,
  fallowCoexistence?: JscpdFallowCoexistenceService,
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdStatusService {
  const owner = new StatusOwner(capabilityService, configService, sessionMode, fallowCoexistence);
  return statusServiceFor(owner, runtime);
}

export function createJscpdStatusWorkflowLayer(
  capabilityService: JscpdCapabilityService,
  configService: JscpdConfigService,
  sessionMode: JscpdSessionModeService,
  fallowCoexistence?: JscpdFallowCoexistenceService,
) {
  const owner = new StatusOwner(capabilityService, configService, sessionMode, fallowCoexistence);
  return Layer.succeed(JscpdStatusWorkflow, statusWorkflowFor(owner));
}

interface StatusState {
  readonly scope: number;
  readonly lastCheck: JscpdLastCheck;
}

class StatusOwner {
  readonly #capability: JscpdCapabilityService;
  readonly #config: JscpdConfigService;
  readonly #mode: JscpdSessionModeService;
  readonly #fallow: JscpdFallowCoexistenceService | undefined;
  readonly #state = MutableRef.make<StatusState>({
    scope: 0,
    lastCheck: Object.freeze({ state: "never" }),
  });

  constructor(
    capability: JscpdCapabilityService,
    config: JscpdConfigService,
    mode: JscpdSessionModeService,
    fallow: JscpdFallowCoexistenceService | undefined,
  ) {
    this.#capability = capability;
    this.#config = config;
    this.#mode = mode;
    this.#fallow = fallow;
  }

  inspectEffect(
    context: JscpdExecutionContext,
  ): Effect.Effect<JscpdStatusResult, never, JscpdProcess> {
    return capabilityProbeEffect(this.#capability, {
      cwd: context.cwd,
      signal: context.signal,
    }).pipe(
      Effect.map((capability) =>
        presentStatus(
          capability,
          this.#config.current(),
          this.#mode,
          MutableRef.get(this.#state).lastCheck,
          this.#fallow,
        ),
      ),
    );
  }

  record(result: JscpdExecutionResult, expectedScope = this.scope()): void {
    const current = MutableRef.get(this.#state);
    if (current.scope !== expectedScope) return;
    const recorded = lastCheckFromResult(result);
    if (recorded) MutableRef.set(this.#state, { ...current, lastCheck: recorded });
  }

  restore(restored?: JscpdLastCheck): void {
    const current = MutableRef.get(this.#state);
    MutableRef.set(this.#state, {
      scope: current.scope + 1,
      lastCheck: restored ?? Object.freeze({ state: "never" }),
    });
  }

  lastCheck(): JscpdLastCheck {
    return MutableRef.get(this.#state).lastCheck;
  }

  scope(): number {
    return MutableRef.get(this.#state).scope;
  }
}

function statusServiceFor(owner: StatusOwner, runtime: JscpdEffectRuntime): JscpdStatusService {
  return {
    inspect: (context) => runtime.runPromise(owner.inspectEffect(context)),
    inspectEffect: (context) => owner.inspectEffect(context),
    record: (result, expectedScope) => owner.record(result, expectedScope),
    recordEffect: (result, expectedScope) => Effect.sync(() => owner.record(result, expectedScope)),
    restore: (lastCheck) => owner.restore(lastCheck),
    lastCheck: () => owner.lastCheck(),
    scope: () => owner.scope(),
    scopeEffect: Effect.sync(() => owner.scope()),
  };
}

function statusWorkflowFor(owner: StatusOwner): JscpdStatusWorkflowService {
  return {
    inspect: (context) => owner.inspectEffect(context),
    record: (result, expectedScope) => Effect.sync(() => owner.record(result, expectedScope)),
    restore: (lastCheck) => Effect.sync(() => owner.restore(lastCheck)),
    lastCheck: Effect.sync(() => owner.lastCheck()),
    scope: Effect.sync(() => owner.scope()),
  };
}

function statusAwareExecutionEffect(
  invocation: Parameters<JscpdCommandExecutor["execute"]>[0],
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
  scanExecutor: JscpdCommandExecutor,
  changedExecutor: JscpdCommandExecutor,
  statusService: JscpdStatusService,
  sessionMode: JscpdSessionModeService,
  stateChanged: () => void,
): Effect.Effect<JscpdExecutionResult, never, JscpdRuntimeRequirements> {
  switch (invocation.command) {
    case "status":
      return statusInspectEffect(statusService, context);
    case "off":
      return Effect.sync(() => {
        sessionMode.disable();
        stateChanged();
        return controlResult(
          "disabled",
          "jscpd behavior is disabled for this session. Run /jscpd on to re-enable it.",
        );
      });
    case "on":
      return Effect.sync(() => {
        sessionMode.enable();
        stateChanged();
        return controlResult(
          "enabled",
          "jscpd behavior is enabled for this session. Project configuration was not changed.",
        );
      });
    case "help":
      return Effect.sync(helpResult);
    case "scan":
      return recordedExecutionEffect(
        scanExecutor,
        invocation,
        context,
        statusService,
        stateChanged,
      );
    case "changed":
      return recordedExecutionEffect(
        changedExecutor,
        invocation,
        context,
        statusService,
        stateChanged,
      );
  }
}

function statusInspectEffect(
  status: JscpdStatusService,
  context: JscpdExecutionContext,
): Effect.Effect<JscpdStatusResult, never, JscpdProcess> {
  return (
    status.inspectEffect?.(context) ??
    Effect.tryPromise({
      try: () => status.inspect(context),
      catch: () => undefined,
    }).pipe(Effect.catchAll(() => Effect.succeed(statusUnavailableResult())))
  );
}

function recordedExecutionEffect(
  executor: JscpdCommandExecutor,
  invocation: Parameters<JscpdCommandExecutor["execute"]>[0],
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
  status: JscpdStatusService,
  stateChanged: () => void,
): Effect.Effect<JscpdExecutionResult, never, JscpdRuntimeRequirements> {
  return Effect.gen(function* () {
    const expectedScope = yield* statusScopeEffect(status);
    const result = yield* commandExecutionEffect(executor, invocation, context);
    yield* status.recordEffect?.(result, expectedScope) ??
      Effect.sync(() => status.record(result, expectedScope));
    yield* Effect.sync(stateChanged);
    return result;
  });
}

function commandExecutionEffect(
  executor: JscpdCommandExecutor,
  invocation: Parameters<JscpdCommandExecutor["execute"]>[0],
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
): Effect.Effect<JscpdExecutionResult, never, JscpdRuntimeRequirements> {
  if (executor.executeEffect) return executor.executeEffect(invocation, context);
  return Effect.tryPromise({
    try: () => executor.execute(invocation, context),
    catch: () => processFailedResult(),
  }).pipe(Effect.catchAll((result) => Effect.succeed(result)));
}

function statusScopeEffect(service: JscpdStatusService): Effect.Effect<number | undefined> {
  return service.scopeEffect ?? Effect.sync(() => service.scope?.());
}

function statusUnavailableResult(): JscpdStatusResult {
  const message = "jscpd status is temporarily unavailable.";
  return Object.freeze({
    status: "status",
    message,
    terminalMessage: message,
    mode: "disabled",
    modeSource: "configuration",
    configSource: "defaults",
    configSources: Object.freeze(["defaults"] as const),
    configDiagnostics: 0,
    capability: Object.freeze({
      status: "failed" as const,
      executable: "jscpd" as const,
      reason: "execution-error" as const,
    }),
    lastCheck: Object.freeze({ state: "never" as const }),
  });
}

function processFailedResult(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "process-failed",
    message: "The jscpd operation failed safely; no result was used.",
  });
}

function presentStatus(
  capability: JscpdCapabilityResult,
  loadedConfig: JscpdConfigLoadResult,
  sessionMode: JscpdSessionModeService,
  lastCheck: JscpdLastCheck,
  fallowCoexistence?: JscpdFallowCoexistenceService,
): JscpdStatusResult {
  const mode = sessionMode.isEnabled() ? "enabled" : "disabled";
  const modeSource = sessionMode.source();
  const configSource = effectiveConfigSource(loadedConfig.sources);
  const lines = [
    "jscpd status",
    `Mode: ${mode}${modeSource === "session" ? " (session override)" : ""}`,
    `Configuration: ${configSourceLabel(configSource)}`,
    capabilityLine(capability),
    stateLine(capability, mode, modeSource),
    `Last check: ${lastCheckLabel(lastCheck)}`,
  ];
  const overlap = fallowCoexistence?.current();
  if (overlap) lines.push(overlap.statusText);
  if (loadedConfig.diagnostics.length > 0) {
    lines.push(
      `Configuration diagnostics: ${loadedConfig.diagnostics.length} invalid source${loadedConfig.diagnostics.length === 1 ? "" : "s"} ignored.`,
    );
  }
  const message = lines.join("\n");
  return Object.freeze({
    status: "status",
    message,
    terminalMessage: message,
    mode,
    modeSource,
    configSource,
    configSources: Object.freeze([...loadedConfig.sources]),
    configDiagnostics: loadedConfig.diagnostics.length,
    capability,
    lastCheck,
    ...(overlap
      ? {
          fallowOverlap: overlap.status,
          fallowAutomatic: overlap.automaticAllowed ? ("allowed" as const) : ("on-demand" as const),
        }
      : {}),
  });
}

function effectiveConfigSource(sources: readonly JscpdConfigSource[]): JscpdConfigSource {
  return sources.at(-1) ?? "defaults";
}

function configSourceLabel(source: JscpdConfigSource): string {
  switch (source) {
    case "defaults":
      return "built-in defaults";
    case "project":
      return `${CONFIG_DIR_NAME}/jscpd-guardrail.json`;
    case "local":
      return `${CONFIG_DIR_NAME}/jscpd-guardrail.local.json (local override)`;
  }
}

function capabilityLine(capability: JscpdCapabilityResult): string {
  switch (capability.status) {
    case "available":
      return `Binary: ${capability.executable} v${capability.version}${capability.source === "bundled" ? " (bundled)" : ""}`;
    case "missing":
      return "Binary: unavailable (checked project, PATH, and bundled jscpd)";
    case "incompatible":
      return `Binary: ${capability.executable} v${capability.version} (requires v5)`;
    case "cancelled":
      return `Binary: ${capability.executable} check cancelled`;
    case "timed-out":
      return `Binary: ${capability.executable} check timed out`;
    case "failed":
      return `Binary: ${capability.executable} check failed`;
  }
}

function stateLine(
  capability: JscpdCapabilityResult,
  mode: JscpdStatusResult["mode"],
  modeSource: JscpdStatusResult["modeSource"],
): string {
  if (mode === "disabled") {
    return modeSource === "session"
      ? "State: disabled for this session; run /jscpd on to re-enable it."
      : "State: disabled by trusted extension configuration.";
  }
  if (capability.status === "missing") {
    return "State: dormant — the bundled jscpd dependency is unavailable; reinstall pi-jscpd.";
  }
  if (capability.status === "available") return "State: ready for explicit scans.";
  return "State: dormant until the binary check succeeds with jscpd v5.";
}

function lastCheckFromResult(result: JscpdExecutionResult): JscpdLastCheck | undefined {
  if (result.status === "completed") return completedLastCheck(result);
  if (result.status === "failed") return failedLastCheck(result);
  if (result.status === "unavailable") return unavailableLastCheck(result);
  return result.status === "changed" ? changedLastCheck(result) : undefined;
}

function changedLastCheck(
  result: Extract<JscpdExecutionResult, { status: "changed" }>,
): JscpdLastCheck | undefined {
  if (!result.scanPerformed) return undefined;
  return result.outcome === "clean"
    ? Object.freeze({ state: "clean" })
    : Object.freeze({
        state: "findings",
        clones: result.findings.length + result.omittedFindings,
      });
}

function completedLastCheck(
  result: Extract<JscpdExecutionResult, { status: "completed" }>,
): JscpdLastCheck {
  return result.outcome === "clean"
    ? Object.freeze({ state: "clean" })
    : Object.freeze({ state: "findings", clones: result.summary.clones });
}

function failedLastCheck(
  result: Extract<JscpdExecutionResult, { status: "failed" }>,
): JscpdLastCheck {
  return result.reason === "scan-cancelled"
    ? Object.freeze({ state: "cancelled" })
    : Object.freeze({ state: "failed", reason: result.reason });
}

function unavailableLastCheck(
  result: Extract<JscpdExecutionResult, { status: "unavailable" }>,
): JscpdLastCheck {
  return result.reason === "probe-cancelled"
    ? Object.freeze({ state: "cancelled" })
    : Object.freeze({ state: "failed", reason: result.reason });
}

function lastCheckLabel(lastCheck: JscpdLastCheck): string {
  switch (lastCheck.state) {
    case "never":
      return "never run";
    case "clean":
      return "clean";
    case "findings":
      return `${lastCheck.clones} duplicate block${lastCheck.clones === 1 ? "" : "s"} found`;
    case "cancelled":
      return "cancelled";
    case "failed":
      return `failed (${failureLabel(lastCheck.reason)})`;
  }
}

function controlResult(action: "enabled" | "disabled", message: string): JscpdExecutionResult {
  return Object.freeze({ status: "control", action, message, terminalMessage: message });
}

function helpResult(): JscpdExecutionResult {
  const message = renderJscpdCommandHelp();
  return Object.freeze({ status: "help", message, terminalMessage: message });
}

function failureLabel(reason: Extract<JscpdLastCheck, { state: "failed" }>["reason"]): string {
  return reason.replaceAll("-", " ");
}
