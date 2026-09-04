import { Effect, Layer } from "effect";
import { JscpdClockLive } from "../../src/effect/clock.js";
import { JscpdFileSystemLive } from "../../src/effect/filesystem.js";
import type {
  JscpdEffectRuntime,
  JscpdRuntimeRequirements,
} from "../../src/effect/runtime-contract.js";
import { JscpdProcessLive } from "../../src/process.js";

const TestLive = Layer.mergeAll(JscpdClockLive, JscpdFileSystemLive, JscpdProcessLive);
const provide = <A, E, R extends JscpdRuntimeRequirements>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E>;

/** Isolated execution boundary for characterization drivers; never included in the package. */
export const JscpdTestEffectRuntime: JscpdEffectRuntime = {
  runPromise: (effect, signal) =>
    Effect.runPromise(provide(effect), signal ? { signal } : undefined),
  runPromiseExit: (effect, signal) =>
    Effect.runPromiseExit(provide(effect), signal ? { signal } : undefined),
  runSync: (effect) => Effect.runSync(provide(effect)),
  dispose: () => Promise.resolve(),
};
