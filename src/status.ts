import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { JscpdCapabilityResult, JscpdCapabilityService } from "./capability.js";
import type { JscpdConfigLoadResult, JscpdConfigService, JscpdConfigSource } from "./config.js";
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
  reset(): void;
}

/** Route scan and status through one public executor while retaining bounded session status. */
export function createJscpdStatusAwareExecutor(
  scanExecutor: JscpdCommandExecutor,
  statusService: JscpdStatusService,
): JscpdCommandExecutor {
  return {
    async execute(invocation, context) {
      if (invocation.command === "status") {
        return statusService.inspect(context);
      }
      const result = await scanExecutor.execute(invocation, context);
      statusService.record(result);
      return result;
    },
  };
}

export function createJscpdStatusService(
  capabilityService: JscpdCapabilityService,
  configService: JscpdConfigService,
): JscpdStatusService {
  let lastCheck: JscpdLastCheck = Object.freeze({ state: "never" });
  return {
    async inspect(context) {
      const capability = await capabilityService.probe({
        cwd: context.cwd,
        signal: context.signal,
      });
      return presentStatus(capability, configService.current(), lastCheck);
    },
    record(result) {
      const recorded = lastCheckFromResult(result);
      if (recorded) lastCheck = recorded;
    },
    reset() {
      lastCheck = Object.freeze({ state: "never" });
    },
  };
}

function presentStatus(
  capability: JscpdCapabilityResult,
  loadedConfig: JscpdConfigLoadResult,
  lastCheck: JscpdLastCheck,
): JscpdStatusResult {
  const mode = loadedConfig.config.enabled ? "enabled" : "disabled";
  const configSource = effectiveConfigSource(loadedConfig.sources);
  const lines = [
    "jscpd status",
    `Mode: ${mode}`,
    `Configuration: ${configSourceLabel(configSource)}`,
    capabilityLine(capability),
    stateLine(capability, mode),
    `Last check: ${lastCheckLabel(lastCheck)}`,
  ];
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
    configSource,
    configSources: Object.freeze([...loadedConfig.sources]),
    configDiagnostics: loadedConfig.diagnostics.length,
    capability,
    lastCheck,
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

function stateLine(capability: JscpdCapabilityResult, mode: JscpdStatusResult["mode"]): string {
  if (mode === "disabled") {
    return "State: disabled by trusted extension configuration.";
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
  switch (result.status) {
    case "completed":
      return result.outcome === "clean"
        ? Object.freeze({ state: "clean" })
        : Object.freeze({ state: "findings", clones: result.summary.clones });
    case "failed":
      return result.reason === "scan-cancelled"
        ? Object.freeze({ state: "cancelled" })
        : Object.freeze({ state: "failed", reason: result.reason });
    case "unavailable":
      return result.reason === "probe-cancelled"
        ? Object.freeze({ state: "cancelled" })
        : Object.freeze({ state: "failed", reason: result.reason });
    case "status":
      return undefined;
  }
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

function failureLabel(reason: Extract<JscpdLastCheck, { state: "failed" }>["reason"]): string {
  return reason.replaceAll("-", " ");
}
