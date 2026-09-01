import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FORCE_SETTLE_MS = 250;
const MAX_PROCESS_TIMEOUT_MS = 5 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINATION_BOUND_MS = 5_000;

export interface BoundedProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  terminationGraceMs?: number;
  forceSettleMs?: number;
}

export type BoundedProcessResult =
  | { status: "completed"; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { status: "not-found" }
  | { status: "cancelled" }
  | { status: "timed-out" }
  | { status: "output-limit" }
  | { status: "invalid-request" }
  | { status: "spawn-failed" };

type TerminalStatus = "cancelled" | "timed-out" | "output-limit";
type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;

export function createProcessEnvironmentWithPath(path: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") {
      delete environment[key];
    }
  }
  environment.PATH = path;
  return environment;
}

/** Run one shell-free child process while owning its output, timers, cancellation, and teardown. */
export function runBoundedProcess(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
  if (!isValidRequest(request)) {
    return Promise.resolve({ status: "invalid-request" });
  }
  if (request.signal.aborted) {
    return Promise.resolve({ status: "cancelled" });
  }

  return new Promise((resolve) => {
    let child: OwnedChild;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: request.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ status: "spawn-failed" });
      return;
    }

    new BoundedChildExecution(child, request, resolve).start();
  });
}

class BoundedChildExecution {
  readonly #child: OwnedChild;
  readonly #request: BoundedProcessRequest;
  readonly #resolve: (result: BoundedProcessResult) => void;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #outputBytes = 0;
  #started = false;
  #settled = false;
  #terminalStatus: TerminalStatus | undefined;
  #timeoutTimer: NodeJS.Timeout | undefined;
  #forceKillTimer: NodeJS.Timeout | undefined;
  #forceSettleTimer: NodeJS.Timeout | undefined;

  constructor(
    child: OwnedChild,
    request: BoundedProcessRequest,
    resolve: (result: BoundedProcessResult) => void,
  ) {
    this.#child = child;
    this.#request = request;
    this.#resolve = resolve;
  }

  start(): void {
    this.#request.signal.addEventListener("abort", this.#cancel, { once: true });
    this.#child.once("spawn", this.#onSpawn);
    this.#child.once("error", this.#onError);
    this.#child.once("close", this.#onClose);
    this.#child.stdout.on("data", this.#captureStdout);
    this.#child.stderr.on("data", this.#captureStderr);
    this.#timeoutTimer = setTimeout(() => this.#terminate("timed-out"), this.#request.timeoutMs);

    if (this.#request.signal.aborted) {
      this.#terminate("cancelled");
    }
  }

  readonly #onSpawn = (): void => {
    this.#started = true;
  };

  readonly #cancel = (): void => {
    this.#terminate("cancelled");
  };

  readonly #captureStdout = (chunk: Buffer | string): void => {
    this.#capture(this.#stdout, chunk);
  };

  readonly #captureStderr = (chunk: Buffer | string): void => {
    this.#capture(this.#stderr, chunk);
  };

  readonly #onError = (error: NodeJS.ErrnoException): void => {
    if (this.#terminalStatus) {
      return;
    }
    if (!this.#started && error.code === "ENOENT") {
      this.#settle({ status: "not-found" });
      return;
    }
    this.#settle({ status: "spawn-failed" });
  };

  readonly #onClose = (code: number | null): void => {
    if (this.#terminalStatus) {
      killOwnedProcessTree(this.#child, "SIGKILL");
      this.#settle({ status: this.#terminalStatus });
      return;
    }
    forceRemainingUnixProcessTree(this.#child);
    this.#settle({
      status: "completed",
      exitCode: code ?? 1,
      stdout: Buffer.concat(this.#stdout),
      stderr: Buffer.concat(this.#stderr),
    });
  };

  #capture(destination: Buffer[], chunk: Buffer | string): void {
    if (this.#terminalStatus || this.#settled) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.#request.maxOutputBytes - this.#outputBytes;
    if (buffer.length > remaining) {
      if (remaining > 0) {
        destination.push(buffer.subarray(0, remaining));
      }
      this.#outputBytes = this.#request.maxOutputBytes;
      this.#terminate("output-limit");
      return;
    }

    destination.push(buffer);
    this.#outputBytes += buffer.length;
  }

  #terminate(status: TerminalStatus): void {
    if (this.#terminalStatus || this.#settled) {
      return;
    }

    this.#terminalStatus = status;
    killOwnedProcessTree(this.#child, "SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      killOwnedProcessTree(this.#child, "SIGKILL");
      this.#forceSettleTimer = setTimeout(
        () => this.#settle({ status }),
        this.#request.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS,
      );
    }, this.#request.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
  }

  #settle(result: BoundedProcessResult): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#cleanup();
    this.#resolve(result);
  }

  #cleanup(): void {
    clearTimeout(this.#timeoutTimer);
    clearTimeout(this.#forceKillTimer);
    clearTimeout(this.#forceSettleTimer);
    this.#request.signal.removeEventListener("abort", this.#cancel);
    this.#child.removeListener("spawn", this.#onSpawn);
    this.#child.removeListener("error", this.#onError);
    this.#child.removeListener("close", this.#onClose);
    this.#child.stdout.removeListener("data", this.#captureStdout);
    this.#child.stderr.removeListener("data", this.#captureStderr);

    if (!this.#child.killed && this.#terminalStatus) {
      killOwnedProcessTree(this.#child, "SIGKILL");
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.once("error", ignoreChildError);
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
      this.#child.unref();
    }
  }
}

function isValidRequest(request: BoundedProcessRequest): boolean {
  if (request === null || typeof request !== "object") {
    return false;
  }
  return (
    hasValidProcessIdentity(request) &&
    hasValidProcessArguments(request.args) &&
    hasValidProcessBounds(request)
  );
}

function hasValidProcessIdentity(request: BoundedProcessRequest): boolean {
  return isSafeProcessToken(request.executable, false) && isSafeProcessToken(request.cwd, false);
}

function hasValidProcessArguments(args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((token) => isSafeProcessToken(token, true));
}

function hasValidProcessBounds(request: BoundedProcessRequest): boolean {
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

function killOwnedProcessTree(child: OwnedChild, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid) {
    signalWindowsProcessTree(child, signal === "SIGKILL");
    return;
  }

  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // A concurrently exited process is already terminated.
  }
}

function forceRemainingUnixProcessTree(child: OwnedChild): void {
  if (process.platform === "win32" || !child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // A process group with no remaining descendants is already clean.
  }
}

function signalWindowsProcessTree(child: OwnedChild, force: boolean): void {
  const args = ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])];
  try {
    const terminator = spawn("taskkill", args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.once("error", () => signalChildFallback(child, force));
    terminator.unref();
  } catch {
    signalChildFallback(child, force);
  }
}

function signalChildFallback(child: OwnedChild, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // A concurrently exited process is already terminated.
  }
}

function ignoreChildError(): void {
  // A late process error after bounded settlement is deliberately private.
}
