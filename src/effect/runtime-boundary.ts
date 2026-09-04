import { type Scope as EffectScope, Layer, ManagedRuntime, Scope } from "effect";
import { JscpdProcessLive } from "../process.js";
import { JscpdClockLive } from "./clock.js";
import { JscpdFileSystemLive } from "./filesystem.js";
import type { JscpdEffectRuntime } from "./runtime-contract.js";

export type { JscpdEffectRuntime, JscpdRuntimeRequirements } from "./runtime-contract.js";

const JscpdRuntimeLive = Layer.mergeAll(JscpdClockLive, JscpdFileSystemLive, JscpdProcessLive);

/** Create the sole managed production runtime for one extension instance. */
export function createJscpdManagedRuntime(): JscpdEffectRuntime {
  const runtime = ManagedRuntime.make(JscpdRuntimeLive);
  return {
    runPromise: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
    runPromiseExit: (effect, signal) =>
      runtime.runPromiseExit(effect, signal ? { signal } : undefined),
    runSync: (effect) => runtime.runSync(effect),
    dispose: () => runtime.dispose(),
  } as JscpdEffectRuntime;
}

export function makeEffectScope(runtime: JscpdEffectRuntime): EffectScope.CloseableScope {
  return runtime.runSync(Scope.make());
}
