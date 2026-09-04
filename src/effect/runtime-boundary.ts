import { Cause, Effect, type Exit as EffectExit, Exit } from "effect";
import { JscpdFileSystemLive } from "./filesystem.js";
import type { JscpdFileSystem } from "./services.js";

/** Temporary non-throwing bridge for interruption and typed-failure inspection. */
export function runEffectExitAtApplicationBoundary<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<EffectExit.Exit<A, E>> {
  return Effect.runPromiseExit(effect, signal ? { signal } : undefined);
}

/** Temporary bridge for Promise callers of filesystem-dependent Effect services. */
export async function runFileSystemEffectAtApplicationBoundary<A, E>(
  effect: Effect.Effect<A, E, JscpdFileSystem>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await runEffectExitAtApplicationBoundary(
    effect.pipe(Effect.provide(JscpdFileSystemLive)),
    signal,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
