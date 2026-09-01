import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export const JSCPD_SUPPORTED_MAJOR = 5;
export const JSCPD_VERSION_TIMEOUT_MS = 2_000;
export const JSCPD_VERSION_MAX_OUTPUT_BYTES = 4_096;

const FORCE_KILL_AFTER_MS = 250;
const VERSION_ARGUMENTS = ["--version"] as const;
const EXECUTABLES = ["jscpd", "cpd"] as const;
const MAX_VERSION_LINE_LENGTH = 128;
const VERSION_PATTERN =
  /^(?:(?:jscpd|cpd)(?:\s+version)?\s*[:=]?\s*)?v?((0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i;

export type JscpdExecutable = (typeof EXECUTABLES)[number];

export type JscpdProbeFailureReason =
  | "malformed-version"
  | "nonzero-exit"
  | "output-limit"
  | "execution-error"
  | "service-disposed";

export type JscpdCapabilityResult =
  | {
      status: "available";
      executable: JscpdExecutable;
      version: string;
      major: typeof JSCPD_SUPPORTED_MAJOR;
    }
  | {
      status: "missing";
      checked: readonly JscpdExecutable[];
    }
  | {
      status: "incompatible";
      executable: JscpdExecutable;
      version: string;
      major: number;
      supportedMajor: typeof JSCPD_SUPPORTED_MAJOR;
    }
  | {
      status: "cancelled";
      executable: JscpdExecutable;
    }
  | {
      status: "timed-out";
      executable: JscpdExecutable;
      timeoutMs: number;
    }
  | {
      status: "failed";
      executable: JscpdExecutable;
      reason: JscpdProbeFailureReason;
      exitCode?: number;
    };

export type JscpdProbeExecutionResult =
  | { status: "completed"; exitCode: number; stdout: string; stderr: string }
  | { status: "missing" }
  | { status: "cancelled" }
  | { status: "timed-out" }
  | { status: "output-limit" }
  | { status: "failed" };

export interface JscpdProbeExecutionRequest {
  executable: JscpdExecutable;
  args: readonly string[];
  cwd: string;
  path: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface JscpdProbeExecutor {
  run(request: JscpdProbeExecutionRequest): Promise<JscpdProbeExecutionResult>;
}

export interface JscpdCapabilityRequest {
  cwd: string;
  signal?: AbortSignal;
  /** Overrides PATH resolution and is primarily useful for deterministic hosts and tests. */
  path?: string;
}

export interface JscpdCapabilityService {
  probe(request: JscpdCapabilityRequest): Promise<JscpdCapabilityResult>;
  invalidate(): void;
  dispose(): void;
}

interface ParsedVersion {
  version: string;
  major: number;
}

interface CachedCapability {
  key: string;
  result: JscpdCapabilityResult;
}

interface CapabilityProbeContext {
  cwd: string;
  path: string;
  key: string;
}

interface VersionProbeContext {
  cwd: string;
  path: string;
  signal: AbortSignal;
}

interface LinkedAbortController {
  controller: AbortController;
  detach: () => void;
}

type StartedProbeExecutionResult = Exclude<JscpdProbeExecutionResult, { status: "missing" }>;

/** Parse the deliberately small set of version lines emitted by supported jscpd CLIs. */
export function parseJscpdVersion(output: string): ParsedVersion | undefined {
  const line = output.trim();
  if (line.length === 0 || line.length > MAX_VERSION_LINE_LENGTH || line.includes("\n")) {
    return undefined;
  }

  const match = VERSION_PATTERN.exec(line);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const major = Number(match[2]);
  if (!Number.isSafeInteger(major)) {
    return undefined;
  }

  return { version: match[1], major };
}

export function createNodeProbeExecutor(): JscpdProbeExecutor {
  return { run: executeNodeProbe };
}

export function createJscpdCapabilityService(
  executor: JscpdProbeExecutor = createNodeProbeExecutor(),
): JscpdCapabilityService {
  return new DefaultJscpdCapabilityService(executor);
}

class DefaultJscpdCapabilityService implements JscpdCapabilityService {
  readonly #executor: JscpdProbeExecutor;
  readonly #activeControllers = new Set<AbortController>();
  #cache: CachedCapability | undefined;
  #resolutionKey: string | undefined;
  #generation = 0;
  #disposed = false;

  constructor(executor: JscpdProbeExecutor) {
    this.#executor = executor;
  }

  async probe(request: JscpdCapabilityRequest): Promise<JscpdCapabilityResult> {
    if (this.#disposed) {
      return serviceDisposedResult();
    }

    const context = createCapabilityProbeContext(request);
    this.#selectResolutionKey(context.key);
    const cached = this.#cachedResult(context.key);
    return cached ?? this.#probeUncached(context, request.signal);
  }

  async #probeUncached(
    context: CapabilityProbeContext,
    requestSignal: AbortSignal | undefined,
  ): Promise<JscpdCapabilityResult> {
    const generation = this.#generation;
    const linkedAbort = createLinkedAbortController(requestSignal);
    this.#activeControllers.add(linkedAbort.controller);

    try {
      const result = await probeExecutables(this.#executor, {
        cwd: context.cwd,
        path: context.path,
        signal: linkedAbort.controller.signal,
      });
      this.#cacheResult(context.key, generation, result);
      return result;
    } finally {
      linkedAbort.detach();
      this.#activeControllers.delete(linkedAbort.controller);
    }
  }

  #cachedResult(key: string): JscpdCapabilityResult | undefined {
    return this.#cache?.key === key ? this.#cache.result : undefined;
  }

  #cacheResult(key: string, generation: number, result: JscpdCapabilityResult): void {
    if (
      isCacheable(result) &&
      !this.#disposed &&
      this.#generation === generation &&
      this.#resolutionKey === key
    ) {
      this.#cache = { key, result };
    }
  }

  invalidate(): void {
    this.#abortActiveProbes();
    this.#generation += 1;
    this.#resolutionKey = undefined;
    this.#cache = undefined;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.invalidate();
  }

  #selectResolutionKey(key: string): void {
    if (this.#resolutionKey === undefined) {
      this.#resolutionKey = key;
      return;
    }
    if (this.#resolutionKey !== key) {
      this.invalidate();
      this.#resolutionKey = key;
    }
  }

  #abortActiveProbes(): void {
    for (const controller of this.#activeControllers) {
      controller.abort();
    }
    this.#activeControllers.clear();
  }
}

async function probeExecutables(
  executor: JscpdProbeExecutor,
  context: VersionProbeContext,
): Promise<JscpdCapabilityResult> {
  for (const executable of EXECUTABLES) {
    const execution = await runVersionProbe(executor, executable, context);
    if (execution.status === "missing") {
      continue;
    }
    return capabilityFromStartedProbe(executable, execution);
  }

  return { status: "missing", checked: EXECUTABLES };
}

async function runVersionProbe(
  executor: JscpdProbeExecutor,
  executable: JscpdExecutable,
  context: VersionProbeContext,
): Promise<JscpdProbeExecutionResult> {
  try {
    return await executor.run({
      executable,
      args: VERSION_ARGUMENTS,
      cwd: context.cwd,
      path: context.path,
      signal: context.signal,
      timeoutMs: JSCPD_VERSION_TIMEOUT_MS,
      maxOutputBytes: JSCPD_VERSION_MAX_OUTPUT_BYTES,
    });
  } catch {
    return { status: "failed" };
  }
}

function capabilityFromStartedProbe(
  executable: JscpdExecutable,
  execution: StartedProbeExecutionResult,
): JscpdCapabilityResult {
  switch (execution.status) {
    case "completed":
      return capabilityFromCompletedProbe(executable, execution);
    case "cancelled":
      return { status: "cancelled", executable };
    case "timed-out":
      return { status: "timed-out", executable, timeoutMs: JSCPD_VERSION_TIMEOUT_MS };
    case "output-limit":
      return { status: "failed", executable, reason: "output-limit" };
    case "failed":
      return { status: "failed", executable, reason: "execution-error" };
  }
}

function capabilityFromCompletedProbe(
  executable: JscpdExecutable,
  execution: Extract<JscpdProbeExecutionResult, { status: "completed" }>,
): JscpdCapabilityResult {
  if (execution.exitCode !== 0) {
    return {
      status: "failed",
      executable,
      reason: "nonzero-exit",
      exitCode: normalizeExitCode(execution.exitCode),
    };
  }
  if (outputExceedsLimit(execution.stdout, execution.stderr)) {
    return { status: "failed", executable, reason: "output-limit" };
  }

  const parsed = parseJscpdVersion(selectVersionOutput(execution));
  if (!parsed) {
    return { status: "failed", executable, reason: "malformed-version" };
  }
  return capabilityFromParsedVersion(executable, parsed);
}

function capabilityFromParsedVersion(
  executable: JscpdExecutable,
  parsed: ParsedVersion,
): JscpdCapabilityResult {
  if (parsed.major !== JSCPD_SUPPORTED_MAJOR) {
    return {
      status: "incompatible",
      executable,
      version: parsed.version,
      major: parsed.major,
      supportedMajor: JSCPD_SUPPORTED_MAJOR,
    };
  }
  return {
    status: "available",
    executable,
    version: parsed.version,
    major: JSCPD_SUPPORTED_MAJOR,
  };
}

function selectVersionOutput(
  execution: Extract<JscpdProbeExecutionResult, { status: "completed" }>,
): string {
  return execution.stdout.trim().length > 0 ? execution.stdout : execution.stderr;
}

function serviceDisposedResult(): JscpdCapabilityResult {
  return {
    status: "failed",
    executable: "jscpd",
    reason: "service-disposed",
  };
}

function createCapabilityProbeContext(request: JscpdCapabilityRequest): CapabilityProbeContext {
  const path = request.path ?? process.env.PATH ?? "";
  return {
    cwd: request.cwd,
    path,
    key: createResolutionKey(request.cwd, path),
  };
}

function createLinkedAbortController(signal: AbortSignal | undefined): LinkedAbortController {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    controller,
    detach: () => signal?.removeEventListener("abort", abort),
  };
}

function createResolutionKey(cwd: string, path: string): string {
  return `${cwd.length}:${cwd}${path}`;
}

function isCacheable(result: JscpdCapabilityResult): boolean {
  return (
    result.status === "available" || result.status === "missing" || result.status === "incompatible"
  );
}

function outputExceedsLimit(stdout: string, stderr: string): boolean {
  return (
    Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") >
    JSCPD_VERSION_MAX_OUTPUT_BYTES
  );
}

function normalizeExitCode(exitCode: number): number {
  return Number.isSafeInteger(exitCode) ? exitCode : 1;
}

function createProbeEnvironment(path: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") {
      delete environment[key];
    }
  }
  environment.PATH = path;
  return environment;
}

async function executeNodeProbe(
  request: JscpdProbeExecutionRequest,
): Promise<JscpdProbeExecutionResult> {
  if (request.signal.aborted) {
    return { status: "cancelled" };
  }

  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: createProbeEnvironment(request.path),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ status: "failed" });
      return;
    }

    let settled = false;
    let started = false;
    let terminalStatus: "cancelled" | "timed-out" | "output-limit" | undefined;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let forceKillTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", cancel);
    };
    const settle = (result: JscpdProbeExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = (status: "cancelled" | "timed-out" | "output-limit") => {
      if (terminalStatus) {
        return;
      }
      terminalStatus = status;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
    };
    const cancel = () => terminate("cancelled");
    const capture = (destination: Buffer[], chunk: Buffer | string) => {
      if (terminalStatus) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = request.maxOutputBytes - outputBytes;
      if (buffer.length > remaining) {
        if (remaining > 0) {
          destination.push(buffer.subarray(0, remaining));
        }
        outputBytes = request.maxOutputBytes;
        terminate("output-limit");
        return;
      }
      destination.push(buffer);
      outputBytes += buffer.length;
    };

    const timeoutTimer = setTimeout(() => terminate("timed-out"), request.timeoutMs);
    request.signal.addEventListener("abort", cancel, { once: true });
    child.once("spawn", () => {
      started = true;
    });
    child.stdout.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (terminalStatus) {
        settle({ status: terminalStatus });
      } else if (!started && error.code === "ENOENT") {
        settle({ status: "missing" });
      } else {
        settle({ status: "failed" });
      }
    });
    child.once("close", (code) => {
      if (terminalStatus) {
        settle({ status: terminalStatus });
        return;
      }
      settle({
        status: "completed",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
