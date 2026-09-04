import { Effect } from "effect";
import {
  createJscpdAutomaticCheck,
  createJscpdAutomaticResultEffectActions,
  handleJscpdAutomaticResultEffect,
  type JscpdAutomaticCheck,
  type JscpdAutomaticCheckEffectScope,
  type JscpdAutomaticResultActions,
} from "../../src/automatic.js";
import type { JscpdAutomaticScanDisposition } from "../../src/scheduler.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "../../src/types.js";
import { JscpdTestEffectRuntime } from "./runtime.js";

type ResultHandler = (
  result: JscpdExecutionResult,
  context: TestCheckContext,
) => JscpdAutomaticScanDisposition | undefined | Promise<JscpdAutomaticScanDisposition | undefined>;
interface TestCheckContext extends JscpdAutomaticCheckEffectScope {
  readonly onResult?: ResultHandler;
}
export type TestAutomaticRun = (
  context: TestCheckContext,
) => Promise<JscpdAutomaticScanDisposition>;

export function automaticFromPromise(run: TestAutomaticRun): JscpdAutomaticCheck {
  return {
    runEffect: (context) =>
      Effect.promise(() =>
        run({
          ...context,
          onResult: context.onResult
            ? (result) =>
                JscpdTestEffectRuntime.runPromise(
                  context.onResult?.(result, context) ?? Effect.succeed(undefined),
                )
            : undefined,
        }),
      ),
  };
}

export function createAutomaticCheckTestDriver(
  executor: JscpdCommandExecutor,
  options: { beforeRun?: () => void; onResult?: ResultHandler } = {},
) {
  const service = createJscpdAutomaticCheck(executor, {
    beforeRun: options.beforeRun ? Effect.sync(options.beforeRun) : undefined,
    onResult: options.onResult
      ? (result, context) =>
          Effect.promise(() => Promise.resolve(options.onResult?.(result, context)))
      : undefined,
  });
  return {
    ...service,
    run: (context: TestCheckContext) =>
      JscpdTestEffectRuntime.runPromise(
        service.runEffect({
          ...context,
          onResult: context.onResult
            ? (result) => Effect.promise(() => Promise.resolve(context.onResult?.(result, context)))
            : undefined,
        }),
      ),
  };
}

export function handleAutomaticResultForTest(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticResultActions,
) {
  return JscpdTestEffectRuntime.runSync(
    handleJscpdAutomaticResultEffect(result, createJscpdAutomaticResultEffectActions(actions)),
  );
}
