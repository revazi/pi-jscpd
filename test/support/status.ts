import { createJscpdStatusService } from "../../src/status.js";
import type { JscpdExecutionContext } from "../../src/types.js";
import { JscpdTestEffectRuntime } from "./runtime.js";

/** Test-boundary runner for status characterization cases. */
export function createStatusTestDriver(...args: Parameters<typeof createJscpdStatusService>) {
  const service = createJscpdStatusService(...args);
  return {
    ...service,
    inspect: (context: JscpdExecutionContext) =>
      JscpdTestEffectRuntime.runPromise(service.inspectEffect(context)),
  };
}
