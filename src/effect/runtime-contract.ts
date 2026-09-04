import type { Effect, Exit as EffectExit } from "effect";
import type { JscpdWorkflowRequirements } from "./services.js";

export type JscpdRuntimeRequirements = JscpdWorkflowRequirements;

/** Host-owned execution boundary shared by every compatibility facade in one extension. */
export interface JscpdEffectRuntime {
  runPromise<A, E, R extends JscpdRuntimeRequirements>(
    effect: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ): Promise<A>;
  runPromiseExit<A, E, R extends JscpdRuntimeRequirements>(
    effect: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ): Promise<EffectExit.Exit<A, E>>;
  runSync<A, E, R extends JscpdRuntimeRequirements>(effect: Effect.Effect<A, E, R>): A;
  dispose(): Promise<void>;
}
