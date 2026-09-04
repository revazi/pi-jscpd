import { Effect } from "effect";
import { createJscpdChangedExecutor } from "../../src/changed.js";
import { createJscpdScanExecutor } from "../../src/scan.js";
import { createJscpdScheduledExecutor } from "../../src/scheduler.js";
import { createJscpdStatusAwareExecutor } from "../../src/status.js";
import type {
  JscpdCommandExecutor,
  JscpdCommandInvocation,
  JscpdExecutionContext,
  JscpdExecutionResult,
} from "../../src/types.js";
import { JscpdTestEffectRuntime } from "./runtime.js";

export type TestCommandExecute = (
  invocation: JscpdCommandInvocation,
  context: JscpdExecutionContext,
) => Promise<JscpdExecutionResult>;

export function commandFromPromise(execute: TestCommandExecute): JscpdCommandExecutor {
  return {
    executeEffect: (invocation, context) => Effect.promise(() => execute(invocation, context)),
  };
}

export function commandTestDriver(executor: JscpdCommandExecutor) {
  return {
    ...executor,
    execute: (...args: Parameters<TestCommandExecute>) =>
      JscpdTestEffectRuntime.runPromise(executor.executeEffect(...args)),
  };
}

export function createChangedCommandTestDriver(
  ...args: Parameters<typeof createJscpdChangedExecutor>
) {
  return commandTestDriver(createJscpdChangedExecutor(...args));
}
export function createScanCommandTestDriver(...args: Parameters<typeof createJscpdScanExecutor>) {
  return commandTestDriver(createJscpdScanExecutor(...args));
}
export function createStatusCommandTestDriver(
  ...args: Parameters<typeof createJscpdStatusAwareExecutor>
) {
  return commandTestDriver(createJscpdStatusAwareExecutor(...args));
}
export function createScheduledCommandTestDriver(
  ...args: Parameters<typeof createJscpdScheduledExecutor>
) {
  return commandTestDriver(createJscpdScheduledExecutor(...args));
}
