import { Effect, type Exit } from "effect";

/** Temporary non-throwing bridge for interruption and typed-failure inspection. */
export function runEffectExitAtApplicationBoundary<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect, signal ? { signal } : undefined);
}
