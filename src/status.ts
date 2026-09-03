import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { JscpdCapabilityResult, JscpdCapabilityService } from "./capability.js";
import type { JscpdConfigLoadResult, JscpdConfigService, JscpdConfigSource } from "./config.js";
import type { JscpdFallowCoexistenceService } from "./fallow.js";
import { renderJscpdCommandHelp } from "./registry.js";
import type {
  JscpdCommandExecutor,
  JscpdExecutionContext,
  JscpdExecutionResult,
  JscpdLastCheck,
  JscpdStatusResult,
} from "./types.js";

export interface JscpdStatusService {
  inspect(context: JscpdExecutionContext): Promise<JscpdStatusResult>;
  record(result: JscpdExecutionResult): void;
  restore(lastCheck?: JscpdLastCheck): void;
  lastCheck(): JscpdLastCheck;
}

export interface JscpdSessionModeService {
  isEnabled(): boolean;
  source(): "configuration" | "session";
  override(): "enabled" | "disabled" | null;
  restore(configuredEnabled: boolean, override?: "enabled" | "disabled" | null): void;
  enable(): void;
  disable(): void;
}

export function createJscpdSessionModeService(): JscpdSessionModeService {
  let enabled = true;
  let source: "configuration" | "session" = "configuration";
  let modeOverride: "enabled" | "disabled" | null = null;
  return {
    isEnabled: () => enabled,
    source: () => source,
    override: () => modeOverride,
    restore(configuredEnabled, restoredOverride = null) {
      modeOverride = restoredOverride;
      enabled = restoredOverride === null ? configuredEnabled : restoredOverride === "enabled";
      source = restoredOverride === null ? "configuration" : "session";
    },
    enable() {
      enabled = true;
      source = "session";
      modeOverride = "enabled";
    },
    disable() {
      enabled = false;
      source = "session";
      modeOverride = "disabled";
    },
  };
}

/** Route all registered commands while retaining bounded session status. */
export function createJscpdStatusAwareExecutor(
  scanExecutor: JscpdCommandExecutor,
  statusService: JscpdStatusService,
  sessionMode: JscpdSessionModeService,
  stateChanged: () => void = () => {},
  changedExecutor: JscpdCommandExecutor = scanExecutor,
): JscpdCommandExecutor {
  return {
    async execute(invocation, context) {
      switch (invocation.command) {
        case "status":
          return statusService.inspect(context);
        case "off":
          sessionMode.disable();
          stateChanged();
          return controlResult(
            "disabled",
            "jscpd behavior is disabled for this session. Run /jscpd on to re-enable it.",
          );
        case "on":
          sessionMode.enable();
          stateChanged();
          return controlResult(
            "enabled",
            "jscpd behavior is enabled for this session. Project configuration was not changed.",
          );
        case "help":
          return helpResult();
        case "scan": {
          const result = await scanExecutor.execute(invocation, context);
          statusService.record(result);
          stateChanged();
          return result;
        }
        case "changed": {
          const result = await changedExecutor.execute(invocation, context);
          statusService.record(result);
          stateChanged();
          return result;
        }
      }
    },
  };
}

export function createJscpdStatusService(
  capabilityService: JscpdCapabilityService,
  configService: JscpdConfigService,
  sessionMode: JscpdSessionModeService,
  fallowCoexistence?: JscpdFallowCoexistenceService,
): JscpdStatusService {
  let lastCheck: JscpdLastCheck = Object.freeze({ state: "never" });
  return {
    async inspect(context) {
      const capability = await capabilityService.probe({
        cwd: context.cwd,
        signal: context.signal,
      });
      return presentStatus(
        capability,
        configService.current(),
        sessionMode,
        lastCheck,
        fallowCoexistence,
      );
    },
    record(result) {
      const recorded = lastCheckFromResult(result);
      if (recorded) lastCheck = recorded;
    },
    restore(restored) {
      lastCheck = restored ?? Object.freeze({ state: "never" });
    },
    lastCheck: () => lastCheck,
  };
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
      return `Binary: ${capability.executable} v${capability.version}`;
    case "missing":
      return "Binary: unavailable (checked jscpd and cpd)";
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
    return "State: dormant — install jscpd v5 and ensure jscpd or cpd is on PATH.";
  }
  if (capability.status === "available") {
    return "State: ready for explicit scans.";
  }
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
