import { parseJscpdCommand } from "./parser.js";
import type {
  JscpdCommandExecutor,
  JscpdDispatchResult,
  JscpdExecutionContext,
  JscpdUnavailableResult,
} from "./types.js";

const NOT_IMPLEMENTED_MESSAGE =
  "jscpd scan is unavailable: executable integration is not implemented yet.";
const EXECUTION_FAILED_MESSAGE = "The jscpd request failed without interrupting the Pi session.";

export const unavailableJscpdExecutor: JscpdCommandExecutor = {
  async execute(): Promise<JscpdUnavailableResult> {
    return {
      status: "unavailable",
      reason: "not-implemented",
      message: NOT_IMPLEMENTED_MESSAGE,
    };
  },
};

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
