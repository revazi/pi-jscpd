import {
  Cause,
  Effect,
  type Exit as EffectExit,
  type Scope as EffectScope,
  Exit,
  Scope,
} from "effect";
import { JscpdFileSystemLive } from "./filesystem.js";
import type { JscpdFileSystem } from "./services.js";

/** Temporary non-throwing bridge for interruption and typed-failure inspection. */
export function runEffectExitAtApplicationBoundary<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<EffectExit.Exit<A, E>> {
  return Effect.runPromiseExit(effect, signal ? { signal } : undefined);
}

/** Temporary Promise bridge for migrated application services. */
export function runEffectPromiseAtApplicationBoundary<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(effect, signal ? { signal } : undefined);
}

/** Temporary synchronous bridge for compatibility facades over one Effect-owned owner. */
export function runEffectSyncAtApplicationBoundary<A, E>(effect: Effect.Effect<A, E>): A {
  return Effect.runSync(effect);
}

/** Temporary scope for compatibility-owned fibers until M7.7 supplies the extension root scope. */
export function makeEffectScopeAtApplicationBoundary(): EffectScope.CloseableScope {
  return runEffectSyncAtApplicationBoundary(Scope.make());
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
