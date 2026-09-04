import { Effect } from "effect";
import type { JscpdRunRequest, JscpdRunResult, JscpdService } from "../../src/jscpd.js";

export type JscpdPromiseRun = <T>(request: JscpdRunRequest<T>) => Promise<JscpdRunResult<T>>;

/** Test-only adapter for characterization fakes retained across the Effect migration. */
export function jscpdServiceFromPromise(run: JscpdPromiseRun): JscpdService {
  return {
    runEffect: (request) => Effect.promise(() => run(request)),
    invalidate() {},
    disposeEffect: () => Effect.void,
  };
}
