import {
  createJscpdChangedFileTracker as createTracker,
  type JscpdMutationToolResult,
} from "../../src/changed-files.js";
import { JscpdTestEffectRuntime } from "../../src/effect/runtime-boundary.js";

/** Test-boundary runner for the existing attribution characterization cases. */
export function createChangedFilesTestDriver() {
  const tracker = createTracker();
  return {
    ...tracker,
    start: (cwd: string, restored?: readonly string[]) =>
      JscpdTestEffectRuntime.runPromise(tracker.startEffect(cwd, restored)),
    recordToolResult: (event: JscpdMutationToolResult, cwd: string) =>
      JscpdTestEffectRuntime.runPromise(tracker.recordToolResultEffect(event, cwd)),
    recordToolResultPath: (event: JscpdMutationToolResult, cwd: string) =>
      JscpdTestEffectRuntime.runPromise(tracker.recordToolResultPathEffect(event, cwd)),
  };
}
