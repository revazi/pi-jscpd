import { delimiter, dirname, join, parse, resolve } from "node:path";
import { Context, Effect, Exit, Layer } from "effect";
import { runEffectExitAtApplicationBoundary } from "./effect/runtime-boundary.js";
import type { JscpdProcess } from "./effect/services.js";
import {
  createProcessEnvironmentWithPath,
  JscpdProcessLive,
  runBoundedProcess,
  runBoundedProcessEffect,
} from "./process.js";

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
  /** Effect-native production route; injected compatibility executors may provide only run. */
  runEffect?: (
    request: JscpdProbeExecutionRequest,
  ) => Effect.Effect<JscpdProbeExecutionResult, never, JscpdProcess>;
}

export interface JscpdCapabilityRequest {
  cwd: string;
  signal?: AbortSignal;
  /** Overrides PATH resolution and is primarily useful for deterministic hosts and tests. */
  path?: string;
}

interface JscpdCapabilityEffectService {
  probe(request: JscpdCapabilityRequest): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess>;
  invalidate(): Effect.Effect<void>;
  dispose(): Effect.Effect<void>;
}

export const JscpdCapability = Context.GenericTag<JscpdCapabilityEffectService>(
  "pi-jscpd/effect/JscpdCapability",
);

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
  return { run: executeNodeProbe, runEffect: executeNodeProbeEffect };
}

export function createJscpdCapabilityService(
  executor: JscpdProbeExecutor = createNodeProbeExecutor(),
): JscpdCapabilityService {
  return new DefaultJscpdCapabilityService(executor);
}

/** Scoped capability layer whose cache and active probes belong to one service instance. */
export function createJscpdCapabilityLayer(
  executor: JscpdProbeExecutor = createNodeProbeExecutor(),
) {
  return Layer.scoped(
    JscpdCapability,
    Effect.acquireRelease(
      Effect.sync(() => new DefaultJscpdCapabilityService(executor)),
      (owner) => owner.disposeEffect(),
    ).pipe(Effect.map(capabilityEffectServiceFor)),
  );
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
    if (this.#disposed) return serviceDisposedResult();
    const context = createCapabilityProbeContext(request);
    this.#selectResolutionKey(context.key);
    const cached = this.#cachedResult(context.key);
    if (cached) return cached;

    const program = this.#probeUncachedEffect(context, request.signal).pipe(
      Effect.provide(JscpdProcessLive),
    );
    const exit = await runEffectExitAtApplicationBoundary(program);
    return Exit.isSuccess(exit)
      ? exit.value
      : { status: "failed", executable: "jscpd", reason: "execution-error" };
  }

  probeEffect(
    request: JscpdCapabilityRequest,
  ): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess> {
    return Effect.suspend(() => {
      if (this.#disposed) return Effect.succeed(serviceDisposedResult());
      const context = createCapabilityProbeContext(request);
      this.#selectResolutionKey(context.key);
      const cached = this.#cachedResult(context.key);
      return cached ? Effect.succeed(cached) : this.#probeUncachedEffect(context, request.signal);
    });
  }

  #probeUncachedEffect(
    context: CapabilityProbeContext,
    requestSignal: AbortSignal | undefined,
  ): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess> {
    const generation = this.#generation;
    const linkedAbort = createLinkedAbortController(requestSignal);
    this.#activeControllers.add(linkedAbort.controller);
    const probe = probeExecutablesEffect(this.#executor, {
      cwd: context.cwd,
      path: context.path,
      executionPath: context.executionPath,
      signal: linkedAbort.controller.signal,
    }).pipe(
      Effect.tap((result) => Effect.sync(() => this.#cacheResult(context.key, generation, result))),
    );
    return Effect.acquireUseRelease(
      Effect.succeed(linkedAbort),
      () => Effect.raceFirst(probe, awaitProbeCancellation(linkedAbort.controller.signal)),
      () =>
        Effect.sync(() => {
          linkedAbort.detach();
          this.#activeControllers.delete(linkedAbort.controller);
        }),
    );
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

  invalidateEffect(): Effect.Effect<void> {
    return Effect.sync(() => this.invalidate());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.invalidate();
  }

  disposeEffect(): Effect.Effect<void> {
    return Effect.sync(() => this.dispose());
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
    for (const controller of this.#activeControllers) controller.abort();
    this.#activeControllers.clear();
  }
}

function capabilityEffectServiceFor(
  owner: DefaultJscpdCapabilityService,
): JscpdCapabilityEffectService {
  return {
    probe: (request) => owner.probeEffect(request),
    invalidate: () => owner.invalidateEffect(),
    dispose: () => owner.disposeEffect(),
  };
}

function awaitProbeCancellation(signal: AbortSignal): Effect.Effect<JscpdCapabilityResult> {
  if (signal.aborted) return Effect.succeed({ status: "cancelled", executable: "jscpd" });
  return Effect.async((resume) => {
    const cancel = () => resume(Effect.succeed({ status: "cancelled", executable: "jscpd" }));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });
}

function probeExecutablesEffect(
  executor: JscpdProbeExecutor,
  context: VersionProbeContext,
): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess> {
  return Effect.gen(function* () {
    let externalFailure: JscpdCapabilityResult | undefined;
    for (const executable of EXECUTABLES) {
      const execution = yield* runVersionProbeEffect(executor, executable, context, context.path);
      if (execution.status === "missing") continue;
      const capability = capabilityFromStartedProbe(executable, execution, "project-or-path");
      if (capability.status === "available" || capability.status === "cancelled") return capability;
      externalFailure = capability;
      break;
    }

    const bundled = yield* runVersionProbeEffect(executor, "jscpd", context, context.executionPath);
    return bundled.status === "missing"
      ? (externalFailure ?? { status: "missing", checked: EXECUTABLES })
      : capabilityFromStartedProbe("jscpd", bundled, "bundled");
  });
}

function runVersionProbeEffect(
  executor: JscpdProbeExecutor,
  executable: JscpdExecutable,
  context: VersionProbeContext,
  path: string,
): Effect.Effect<JscpdProbeExecutionResult, never, JscpdProcess> {
  const request = {
    executable,
    args: VERSION_ARGUMENTS,
    cwd: context.cwd,
    path,
    signal: context.signal,
    timeoutMs: JSCPD_VERSION_TIMEOUT_MS,
    maxOutputBytes: JSCPD_VERSION_MAX_OUTPUT_BYTES,
  } satisfies JscpdProbeExecutionRequest;
  if (executor.runEffect) return executor.runEffect(request);
  return Effect.tryPromise({
    try: (signal) => {
      const linkedAbort = createLinkedAbortController(context.signal, signal);
      return executor
        .run({ ...request, signal: linkedAbort.controller.signal })
        .finally(linkedAbort.detach);
    },
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => ({ status: "failed" }), onSuccess: (result) => result }));
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

function createLinkedAbortController(
  ...signals: readonly (AbortSignal | undefined)[]
): LinkedAbortController {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    controller,
    detach: () => {
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    },
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

function executeNodeProbeEffect(
  request: JscpdProbeExecutionRequest,
): Effect.Effect<JscpdProbeExecutionResult, never, JscpdProcess> {
  return runBoundedProcessEffect({
    stage: "probe",
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    environment: createProcessEnvironmentWithPath(request.path),
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  }).pipe(Effect.map(probeExecutionResult));
}

async function executeNodeProbe(
  request: JscpdProbeExecutionRequest,
): Promise<JscpdProbeExecutionResult> {
  const result = await runBoundedProcess({
    stage: "probe",
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    env: createProcessEnvironmentWithPath(request.path),
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  });

  return probeExecutionResult(result);
}

function probeExecutionResult(
  result: Awaited<ReturnType<typeof runBoundedProcess>>,
): JscpdProbeExecutionResult {
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
