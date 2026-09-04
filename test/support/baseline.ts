import {
  createJscpdBaselineService as createService,
  type JscpdBaselineStartContext,
} from "../../src/baseline.js";
import { JscpdTestEffectRuntime } from "../../src/effect/runtime-boundary.js";

/** Explicit test runner for baseline characterization; production exposes only effects. */
export function createBaselineTestDriver(...args: Parameters<typeof createService>) {
  const service = createService(...args);
  return {
    ...service,
    start: (context: JscpdBaselineStartContext) =>
      JscpdTestEffectRuntime.runPromise(service.startEffect(context)),
    wait: () => JscpdTestEffectRuntime.runPromise(service.waitEffect),
  };
}
