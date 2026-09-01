import type { JscpdCapabilityResult, JscpdCapabilityService } from "./capability.js";
import { parseJscpdCommand } from "./parser.js";
import type {
  JscpdCommandExecutor,
  JscpdDispatchResult,
  JscpdExecutionContext,
  JscpdUnavailableResult,
} from "./types.js";

const EXECUTION_FAILED_MESSAGE = "The jscpd request failed without interrupting the Pi session.";

export function createCapabilityAwareJscpdExecutor(
  capabilityService: JscpdCapabilityService,
): JscpdCommandExecutor {
  return {
    async execute(_invocation, context): Promise<JscpdUnavailableResult> {
      const capability = await capabilityService.probe({
        cwd: context.cwd,
        signal: context.signal,
      });
      return capabilityUnavailableResult(capability);
    },
  };
}

export async function dispatchJscpdCommand(
  command: unknown,
  args: unknown,
  context: JscpdExecutionContext,
  executor: JscpdCommandExecutor,
): Promise<JscpdDispatchResult> {
  const parsed = parseJscpdCommand(command, args);
  if (!parsed.ok) {
    return {
      status: "invalid",
      reason: parsed.error.code,
      message: parsed.error.message,
    };
  }

  try {
    return await executor.execute(parsed.invocation, context);
  } catch {
    return {
      status: "error",
      reason: "execution-failed",
      message: EXECUTION_FAILED_MESSAGE,
    };
  }
}

function capabilityUnavailableResult(capability: JscpdCapabilityResult): JscpdUnavailableResult {
  switch (capability.status) {
    case "available":
      return {
        status: "unavailable",
        reason: "not-implemented",
        message: `jscpd scan execution is not implemented yet (detected ${capability.executable} v${capability.version}).`,
        capability,
      };
    case "missing":
      return {
        status: "unavailable",
        reason: "missing-binary",
        message: "jscpd scan is unavailable: install jscpd v5 and ensure jscpd or cpd is on PATH.",
        capability,
      };
    case "incompatible":
      return {
        status: "unavailable",
        reason: "incompatible-version",
        message: `jscpd scan requires v5; ${capability.executable} reported v${capability.version}.`,
        capability,
      };
    case "cancelled":
      return {
        status: "unavailable",
        reason: "probe-cancelled",
        message: "The jscpd executable check was cancelled; no scan ran.",
        capability,
      };
    case "timed-out":
      return {
        status: "unavailable",
        reason: "probe-timed-out",
        message: "The jscpd executable check timed out; no scan ran.",
        capability,
      };
    case "failed":
      return {
        status: "unavailable",
        reason: "probe-failed",
        message: "The jscpd executable check failed safely; no scan ran.",
        capability,
      };
  }
}
