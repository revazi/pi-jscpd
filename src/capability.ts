import { delimiter, dirname, join, parse, resolve } from "node:path";
import { createProcessEnvironmentWithPath, runBoundedProcess } from "./process.js";

export const JSCPD_SUPPORTED_MAJOR = 5;
export const JSCPD_VERSION_TIMEOUT_MS = 2_000;
export const JSCPD_VERSION_MAX_OUTPUT_BYTES = 4_096;

const VERSION_ARGUMENTS = ["--version"] as const;
const EXECUTABLES = ["jscpd", "cpd"] as const;
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const MAX_PROJECT_BIN_DIRECTORIES = 64;
const MAX_VERSION_LINE_LENGTH = 128;
const VERSION_PATTERN =
  /^(?:(?:jscpd|cpd)(?:\s+version)?\s*[:=]?\s*)?v?((0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i;

export type JscpdExecutable = (typeof EXECUTABLES)[number];
export type JscpdCapabilitySource = "project-or-path" | "bundled";

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
      source?: JscpdCapabilitySource;
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
      source?: JscpdCapabilitySource;
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
  executionPath: string;
  key: string;
}

interface VersionProbeContext {
  cwd: string;
  path: string;
  executionPath: string;
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
        executionPath: context.executionPath,
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
  let externalFailure: JscpdCapabilityResult | undefined;
  for (const executable of EXECUTABLES) {
    const execution = await runVersionProbe(executor, executable, context, context.path);
    if (execution.status === "missing") {
      continue;
    }
    const capability = capabilityFromStartedProbe(executable, execution, "project-or-path");
    if (capability.status === "available" || capability.status === "cancelled") {
      return capability;
    }
    externalFailure = capability;
    break;
  }

  const bundled = await runVersionProbe(executor, "jscpd", context, context.executionPath);
  return bundled.status === "missing"
    ? (externalFailure ?? { status: "missing", checked: EXECUTABLES })
    : capabilityFromStartedProbe("jscpd", bundled, "bundled");
}

async function runVersionProbe(
  executor: JscpdProbeExecutor,
  executable: JscpdExecutable,
  context: VersionProbeContext,
  path: string,
): Promise<JscpdProbeExecutionResult> {
  try {
    return await executor.run({
      executable,
      args: VERSION_ARGUMENTS,
      cwd: context.cwd,
      path,
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
  source: JscpdCapabilitySource,
): JscpdCapabilityResult {
  switch (execution.status) {
    case "completed":
      return capabilityFromCompletedProbe(executable, execution, source);
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
  source: JscpdCapabilitySource,
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
  return capabilityFromParsedVersion(executable, parsed, source);
}

function capabilityFromParsedVersion(
  executable: JscpdExecutable,
  parsed: ParsedVersion,
  source: JscpdCapabilitySource,
): JscpdCapabilityResult {
  if (parsed.major !== JSCPD_SUPPORTED_MAJOR) {
    return {
      status: "incompatible",
      executable,
      version: parsed.version,
      major: parsed.major,
      supportedMajor: JSCPD_SUPPORTED_MAJOR,
      source,
    };
  }
  return {
    status: "available",
    executable,
    version: parsed.version,
    major: JSCPD_SUPPORTED_MAJOR,
    source,
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
  const configuredPath = request.path ?? process.env.PATH ?? "";
  return {
    cwd: request.cwd,
    path: createExternalJscpdPath(request.cwd, configuredPath),
    executionPath: createJscpdExecutionPath(request.cwd, configuredPath, "bundled"),
    key: createResolutionKey(request.cwd, configuredPath),
  };
}

/** Build the deterministic PATH used for scans after capability resolution. */
export function createJscpdExecutionPath(
  cwd: string,
  configuredPath: string = process.env.PATH ?? "",
  source: JscpdCapabilitySource = "project-or-path",
): string {
  const external = [...projectBinDirectories(cwd), configuredPath];
  const bundled = [join(PACKAGE_ROOT, "node_modules", ".bin"), join(dirname(PACKAGE_ROOT), ".bin")];
  return joinPathEntries(
    source === "bundled" ? [...bundled, ...external] : [...external, ...bundled],
  );
}

function createExternalJscpdPath(cwd: string, configuredPath: string): string {
  return joinPathEntries([...projectBinDirectories(cwd), configuredPath]);
}

function projectBinDirectories(cwd: string): string[] {
  const directories: string[] = [];
  let current = resolve(cwd);
  for (let depth = 0; depth < MAX_PROJECT_BIN_DIRECTORIES; depth += 1) {
    directories.push(join(current, "node_modules", ".bin"));
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return directories;
}

function joinPathEntries(entries: readonly string[]): string {
  return entries.filter((entry) => entry.length > 0).join(delimiter);
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

async function executeNodeProbe(
  request: JscpdProbeExecutionRequest,
): Promise<JscpdProbeExecutionResult> {
  const result = await runBoundedProcess({
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    env: createProcessEnvironmentWithPath(request.path),
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  });

  switch (result.status) {
    case "completed":
      return {
        status: "completed",
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    case "not-found":
      return { status: "missing" };
    case "cancelled":
    case "timed-out":
    case "output-limit":
      return { status: result.status };
    case "invalid-request":
    case "spawn-failed":
      return { status: "failed" };
  }
}
