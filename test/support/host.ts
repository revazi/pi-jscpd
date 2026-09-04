import { dispatchJscpdCommand } from "../../src/dispatch.js";
import {
  createJscpdSlashCommandDefinition,
  createJscpdToolDefinition,
} from "../../src/extension.js";
import type { JscpdOverlayLauncher } from "../../src/overlay.js";
import type { JscpdCommandExecutor, JscpdExecutionContext } from "../../src/types.js";
import { JscpdTestEffectRuntime } from "./runtime.js";

export function dispatchTestCommand(
  command: unknown,
  args: unknown,
  context: JscpdExecutionContext,
  executor: JscpdCommandExecutor,
) {
  return dispatchJscpdCommand(command, args, context, executor, JscpdTestEffectRuntime);
}
export function createTestToolDefinition(executor: JscpdCommandExecutor) {
  return createJscpdToolDefinition(executor, JscpdTestEffectRuntime);
}
export function createTestSlashCommandDefinition(
  executor: JscpdCommandExecutor,
  overlay?: JscpdOverlayLauncher,
) {
  return createJscpdSlashCommandDefinition(executor, overlay, JscpdTestEffectRuntime);
}
