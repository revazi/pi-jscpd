import { Effect, Scope } from "effect";
import {
  createJscpdScanScheduler,
  type JscpdAutomaticScanContext,
  type JscpdAutomaticScanDisposition,
} from "../../src/scheduler.js";
import { JscpdTestEffectRuntime } from "./runtime.js";

/** Characterization driver owns an isolated scope and executes only at the test boundary. */
export function createSchedulerTestDriver() {
  const runtime = JscpdTestEffectRuntime;
  const native = createJscpdScanScheduler(Effect.runSync(Scope.make()));
  let disposed: Promise<void> | undefined;
  const driver = {
    ...native,
    markChanged: () => runtime.runSync(native.markChangedEffect),
    requestAutomatic: (
      task: (context: JscpdAutomaticScanContext) => Promise<JscpdAutomaticScanDisposition>,
    ) =>
      runtime.runSync(
        native.scheduleAutomaticEffect((context) => Effect.promise(() => task(context))),
      ),
    runExplicit: <T>(task: () => Promise<T>) =>
      runtime.runPromise(native.runExplicitEffect(Effect.promise(task))),
    cancelAutomatic: () => runtime.runSync(native.cancelAutomaticEffect),
    reset: () => runtime.runSync(native.resetEffect),
    dispose: () => (disposed ??= runtime.runPromise(native.disposeEffect)),
    snapshot: () => runtime.runSync(native.snapshotEffect),
  };
  return Object.assign(driver, {
    markChangedEffect: Effect.sync(() => driver.markChanged()),
    cancelAutomaticEffect: Effect.sync(() => driver.cancelAutomatic()),
    resetEffect: Effect.sync(() => driver.reset()),
    disposeEffect: Effect.promise(() => driver.dispose()),
  });
}
