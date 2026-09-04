import {
  Cause,
  Effect,
  type Scope as EffectScope,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import { JscpdProcessLive } from "../process.js";
import { JscpdClockLive } from "./clock.js";
import { JscpdFileSystemLive } from "./filesystem.js";
import type { JscpdEffectRuntime, JscpdRuntimeRequirements } from "./runtime-contract.js";
import type { JscpdFileSystem } from "./services.js";

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

/** Isolated compatibility runner used only by direct unit-level service factories. */
export const JscpdTestEffectRuntime: JscpdEffectRuntime = {
  runPromise: (effect, signal) =>
    Effect.runPromise(testProgram(effect), signal ? { signal } : undefined),
  runPromiseExit: (effect, signal) =>
    Effect.runPromiseExit(testProgram(effect), signal ? { signal } : undefined),
  runSync: (effect) => Effect.runSync(testProgram(effect)),
  dispose: () => Promise.resolve(),
};

function testProgram<A, E, R extends JscpdRuntimeRequirements>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provide(JscpdRuntimeLive)) as Effect.Effect<A, E>;
}

export function makeEffectScope(runtime: JscpdEffectRuntime): EffectScope.CloseableScope {
  return runtime.runSync(Scope.make());
}

/** Isolated compatibility adapter retained for deterministic lower-service tests. */
export function runFileSystemEffectForTest<A, E>(
  effect: Effect.Effect<A, E, JscpdFileSystem>,
  signal?: AbortSignal,
): Promise<A> {
  return runFileSystemEffect(JscpdTestEffectRuntime, effect, signal);
}

async function runFileSystemEffect<A, E>(
  runtime: JscpdEffectRuntime,
  effect: Effect.Effect<A, E, JscpdFileSystem>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect, signal);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
