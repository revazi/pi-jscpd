// fallow-ignore-file security-sink -- This bounded shell-free process owner validates command tokens and never constructs a shell string.
import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { Effect, Exit, Layer } from "effect";
import {
  JscpdInvalidInput,
  JscpdLimitExceeded,
  JscpdOperationTimedOut,
  JscpdProcessFailure,
} from "./effect/errors.js";
import {
  JscpdProcess,
  type JscpdProcessRequest,
  type JscpdProcessResult,
  type JscpdProcessRunError,
} from "./effect/services.js";

const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FORCE_SETTLE_MS = 250;
const MAX_PROCESS_TIMEOUT_MS = 5 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINATION_BOUND_MS = 5_000;

export type BoundedProcessResult =
  | { status: "completed"; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { status: "not-found" }
  | { status: "cancelled" }
  | { status: "timed-out" }
  | { status: "output-limit" }
  | { status: "invalid-request" }
  | { status: "spawn-failed" };

type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;

export function createProcessEnvironmentWithPath(path: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = path;
  return environment;
}

/** Live shell-free process service. Every child is acquired and finalized by its calling effect. */
export const JscpdProcessLive = Layer.succeed(JscpdProcess, {
  run: runProcessEffect,
});

/** Effect-native bounded execution used by analyzer services through the host's process layer. */
export function runBoundedProcessEffect(
  request: JscpdProcessRequest,
): Effect.Effect<BoundedProcessResult, never, JscpdProcess> {
  return Effect.flatMap(JscpdProcess, (service) => service.run(request)).pipe(
    Effect.match({ onFailure: legacyProcessFailure, onSuccess: completedLegacyProcessResult }),
  );
}

function runProcessEffect(
  request: JscpdProcessRequest,
): Effect.Effect<JscpdProcessResult, JscpdProcessRunError> {
  if (!isValidRequest(request)) {
    return Effect.fail(new JscpdInvalidInput({ subject: "process-request", reason: "invalid" }));
  }
  return Effect.acquireUseRelease(
    acquireOwnedProcess(request),
    (owned) =>
      Effect.exit(awaitOwnedProcess(owned, request)).pipe(Effect.map((exit) => ({ owned, exit }))),
    releaseOwnedProcess,
  ).pipe(
    Effect.flatMap(({ owned, exit }) =>
      owned.terminationUncertain
        ? Effect.fail(new JscpdProcessFailure({ stage: owned.stage, reason: "termination" }))
        : effectFromProcessExit(exit),
    ),
  );
}

function effectFromProcessExit(
  exit: Exit.Exit<JscpdProcessResult, JscpdProcessRunError>,
): Effect.Effect<JscpdProcessResult, JscpdProcessRunError> {
  return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
}

function acquireOwnedProcess(
  request: JscpdProcessRequest,
): Effect.Effect<OwnedProcess, JscpdProcessFailure> {
  return Effect.try({
    try: () =>
      new OwnedProcess(
        spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: request.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
        request.stage,
        request.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
        request.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS,
      ),
    catch: () => new JscpdProcessFailure({ stage: request.stage, reason: "spawn" }),
  });
}

function awaitOwnedProcess(
  owned: OwnedProcess,
  request: JscpdProcessRequest,
): Effect.Effect<JscpdProcessResult, JscpdProcessRunError> {
  const execution = owned.await(request.maxOutputBytes);
  const timeout = Effect.sleep(request.timeoutMs).pipe(
    Effect.flatMap(() => Effect.fail(new JscpdOperationTimedOut({ stage: request.stage }))),
  );
  return Effect.raceFirst(execution, timeout);
}

function releaseOwnedProcess(owned: OwnedProcess): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (owned.closed) {
      yield* settleRemainingProcessTree(owned);
      owned.detach();
      return;
    }

    yield* signalOwnedProcessTree(owned.child, "SIGTERM");
    yield* waitUntilClosedOrDelay(owned, owned.terminationGraceMs);
    if (!owned.closed) {
      yield* signalOwnedProcessTree(owned.child, "SIGKILL");
      yield* waitUntilClosedOrDelay(owned, owned.forceSettleMs);
    }
    yield* settleRemainingProcessTree(owned);
    owned.detach();
  });
}

class OwnedProcess {
  readonly child: OwnedChild;
  readonly stage: "probe" | "scan";
  readonly terminationGraceMs: number;
  readonly forceSettleMs: number;
  terminationUncertain = false;
  #closed = false;
  #detached = false;

  constructor(
    child: OwnedChild,
    stage: "probe" | "scan",
    terminationGraceMs: number,
    forceSettleMs: number,
  ) {
    this.child = child;
    this.stage = stage;
    this.terminationGraceMs = terminationGraceMs;
    this.forceSettleMs = forceSettleMs;
    child.once("close", this.#onClose);
    child.on("error", ignoreChildError);
  }

  get closed(): boolean {
    return this.#closed || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  await(maxOutputBytes: number): Effect.Effect<JscpdProcessResult, JscpdProcessRunError> {
    return Effect.async((resume) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (effect: Effect.Effect<JscpdProcessResult, JscpdProcessRunError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const capture = (destination: Buffer[], chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxOutputBytes - outputBytes;
        if (buffer.length > remaining) {
          if (remaining > 0) destination.push(buffer.subarray(0, remaining));
          finish(Effect.fail(new JscpdLimitExceeded({ subject: "process-output" })));
          return;
        }
        destination.push(buffer);
        outputBytes += buffer.length;
      };
      const onStdout = (chunk: Buffer | string) => capture(stdout, chunk);
      const onStderr = (chunk: Buffer | string) => capture(stderr, chunk);
      const onError = (error: NodeJS.ErrnoException) =>
        finish(
          Effect.fail(
            new JscpdProcessFailure({
              stage: this.stage,
              reason: error.code === "ENOENT" ? "not-found" : "spawn",
            }),
          ),
        );
      const onClose = (code: number | null) =>
        finish(
          Effect.succeed({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }),
        );
      const cleanup = () => {
        this.child.stdout.removeListener("data", onStdout);
        this.child.stderr.removeListener("data", onStderr);
        this.child.removeListener("error", onError);
        this.child.removeListener("close", onClose);
      };

      this.child.stdout.on("data", onStdout);
      this.child.stderr.on("data", onStderr);
      this.child.once("error", onError);
      this.child.once("close", onClose);
      return Effect.sync(cleanup);
    });
  }

  waitForClose(): Effect.Effect<void> {
    if (this.closed) return Effect.void;
    return Effect.async((resume) => {
      const close = () => resume(Effect.void);
      this.child.once("close", close);
      return Effect.sync(() => this.child.removeListener("close", close));
    });
  }

  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.child.removeListener("close", this.#onClose);
    this.child.removeListener("error", ignoreChildError);
    if (!this.closed) {
      this.child.once("error", ignoreChildError);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.unref();
    }
  }

  readonly #onClose = (): void => {
    this.#closed = true;
  };
}

function waitUntilClosedOrDelay(owned: OwnedProcess, milliseconds: number): Effect.Effect<void> {
  return Effect.raceFirst(
    owned.waitForClose().pipe(Effect.interruptible),
    Effect.sleep(milliseconds).pipe(Effect.interruptible),
  );
}

function isValidRequest(request: JscpdProcessRequest): boolean {
  return (
    request !== null &&
    typeof request === "object" &&
    (request.stage === "probe" || request.stage === "scan") &&
    hasValidProcessIdentity(request) &&
    hasValidProcessArguments(request.args) &&
    hasValidProcessBounds(request)
  );
}

function hasValidProcessIdentity(request: JscpdProcessRequest): boolean {
  return isSafeProcessToken(request.executable, false) && isSafeProcessToken(request.cwd, false);
}

function hasValidProcessArguments(args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((token) => isSafeProcessToken(token, true));
}

function hasValidProcessBounds(request: JscpdProcessRequest): boolean {
  const durationBoundsAreValid =
    isBoundedPositiveInteger(request.timeoutMs, MAX_PROCESS_TIMEOUT_MS) &&
    isOptionalBoundedPositiveInteger(request.terminationGraceMs, MAX_TERMINATION_BOUND_MS) &&
    isOptionalBoundedPositiveInteger(request.forceSettleMs, MAX_TERMINATION_BOUND_MS);
  return (
    durationBoundsAreValid &&
    isBoundedPositiveInteger(request.maxOutputBytes, MAX_PROCESS_OUTPUT_BYTES)
  );
}

function isSafeProcessToken(value: string, allowEmpty: boolean): boolean {
  return typeof value === "string" && (allowEmpty || value.length > 0) && !value.includes("\0");
}

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isOptionalBoundedPositiveInteger(value: number | undefined, maximum: number): boolean {
  return value === undefined || isBoundedPositiveInteger(value, maximum);
}

function signalOwnedProcessTree(child: OwnedChild, signal: NodeJS.Signals): Effect.Effect<void> {
  if (process.platform === "win32" && child.pid) {
    return signalWindowsProcessTree(child, signal === "SIGKILL");
  }
  return Effect.sync(() => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // A concurrently exited process is already terminated.
    }
  });
}

function settleRemainingProcessTree(owned: OwnedProcess): Effect.Effect<void> {
  return Effect.gen(function* () {
    forceRemainingUnixProcessTree(owned.child);
    if (processStillExists(owned.child)) {
      yield* Effect.sleep(owned.forceSettleMs).pipe(Effect.interruptible);
    }
    owned.terminationUncertain = processStillExists(owned.child);
  });
}

function forceRemainingUnixProcessTree(child: OwnedChild): void {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // A process group with no remaining descendants is already clean.
  }
}

function signalWindowsProcessTree(child: OwnedChild, force: boolean): Effect.Effect<void> {
  return Effect.async((resume) => {
    let terminator: ReturnType<typeof spawn>;
    try {
      terminator = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      signalChildFallback(child, force);
      resume(Effect.void);
      return;
    }
    const finish = () => {
      cleanup();
      resume(Effect.void);
    };
    const fallback = () => {
      signalChildFallback(child, force);
      finish();
    };
    const cleanup = () => {
      terminator.removeListener("close", finish);
      terminator.removeListener("error", fallback);
    };
    terminator.once("close", finish);
    terminator.once("error", fallback);
    return Effect.sync(() => {
      cleanup();
      if (terminator.exitCode === null && terminator.signalCode === null) {
        try {
          terminator.kill("SIGKILL");
        } catch {
          terminator.unref();
        }
      }
    });
  }).pipe((effect) =>
    Effect.raceFirst(
      effect.pipe(Effect.interruptible),
      Effect.sleep(250).pipe(Effect.interruptible),
    ),
  );
}

function signalChildFallback(child: OwnedChild, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // A concurrently exited process is already terminated.
  }
}

function processStillExists(child: OwnedChild): boolean {
  if (!child.pid) return false;
  if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) {
    return false;
  }
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function completedLegacyProcessResult(result: JscpdProcessResult): BoundedProcessResult {
  return {
    status: "completed",
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr),
  };
}

function legacyProcessFailure(error: JscpdProcessRunError): BoundedProcessResult {
  switch (error._tag) {
    case "JscpdProcessFailure":
      return { status: error.reason === "not-found" ? "not-found" : "spawn-failed" };
    case "JscpdOperationCancelled":
      return { status: "cancelled" };
    case "JscpdOperationTimedOut":
      return { status: "timed-out" };
    case "JscpdLimitExceeded":
      return { status: "output-limit" };
    case "JscpdInvalidInput":
      return { status: "invalid-request" };
  }
}

function ignoreChildError(): void {
  // A late process error after bounded settlement is deliberately private.
}
