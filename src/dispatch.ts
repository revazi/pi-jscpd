import { Cause, Effect } from "effect";
import {
  type JscpdEffectRuntime,
  type JscpdRuntimeRequirements,
  JscpdTestEffectRuntime,
} from "./effect/runtime-boundary.js";
import { parseJscpdCommand } from "./parser.js";
import type { JscpdCommandExecutor, JscpdDispatchResult, JscpdExecutionContext } from "./types.js";

const EXECUTION_FAILED_MESSAGE = "The jscpd request failed without interrupting the Pi session.";

function dispatchJscpdCommandEffect(
  command: unknown,
  args: unknown,
  context: JscpdExecutionContext,
  executor: JscpdCommandExecutor,
): Effect.Effect<JscpdDispatchResult, never, JscpdRuntimeRequirements> {
  return Effect.suspend(() => {
    const parsed = parseJscpdCommand(command, args);
    if (!parsed.ok) {
      return Effect.succeed({
        status: "invalid" as const,
        reason: parsed.error.code,
        message: parsed.error.message,
      });
    }
    const executed: Effect.Effect<JscpdDispatchResult, never, JscpdRuntimeRequirements> =
      executor.executeEffect
        ? interruptOnSignal(
            executor.executeEffect(parsed.invocation, context),
            context.signal,
            parsed.invocation.command,
          )
        : Effect.tryPromise({
            try: () => executor.execute(parsed.invocation, context),
            catch: () => executionFailedResult(),
          }).pipe(Effect.catchAll((result) => Effect.succeed(result)));
    return executed.pipe(Effect.catchAllCause(() => Effect.succeed(executionFailedResult())));
  });
}

export function dispatchJscpdCommand(
  command: unknown,
  args: unknown,
  context: JscpdExecutionContext,
  executor: JscpdCommandExecutor,
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): Promise<JscpdDispatchResult> {
  return runtime.runPromise(dispatchJscpdCommandEffect(command, args, context, executor));
}

function interruptOnSignal<R extends JscpdRuntimeRequirements>(
  effect: Effect.Effect<JscpdDispatchResult, never, R>,
  signal: AbortSignal | undefined,
  command: "scan" | "changed" | "status" | "off" | "on" | "help",
): Effect.Effect<JscpdDispatchResult, never, R> {
  if (!signal) return effect;
  const interrupted = Effect.async<never>((resume) => {
    const abort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
  return Effect.raceFirst(effect, interrupted).pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.succeed(commandCancellationResult(command))
        : Effect.failCause(cause),
    ),
  );
}

function commandCancellationResult(
  command: "scan" | "changed" | "status" | "off" | "on" | "help",
): JscpdDispatchResult {
  if (command === "scan") {
    return {
      status: "failed",
      reason: "scan-cancelled",
      message: "The jscpd scan was cancelled and its temporary report was removed.",
    };
  }
  if (command === "changed") {
    return {
      status: "changed-unavailable",
      reason: "baseline-cancelled",
      message:
        "The changed-duplication check was cancelled by a session branch transition; no findings were acknowledged.",
    };
  }
  return executionFailedResult();
}

function executionFailedResult(): JscpdDispatchResult {
  return {
    status: "error",
    reason: "execution-failed",
    message: EXECUTION_FAILED_MESSAGE,
  };
}
