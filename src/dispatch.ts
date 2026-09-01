import { parseJscpdCommand } from "./parser.js";
import type { JscpdCommandExecutor, JscpdDispatchResult, JscpdExecutionContext } from "./types.js";

const EXECUTION_FAILED_MESSAGE = "The jscpd request failed without interrupting the Pi session.";

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
