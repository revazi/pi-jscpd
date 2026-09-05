import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Cause, Context, Effect, Layer } from "effect";
import { type JscpdFileSystemFailure, JscpdLimitExceeded } from "./effect/errors.js";
import {
  JscpdFileSystem,
  type JscpdFileSystem as JscpdFileSystemService,
  type JscpdProcess,
} from "./effect/services.js";
import { isJscpdReportErrorCode, JSCPD_STRUCTURED_REPORT_FILE_NAME } from "./jscpd-report.js";
import {
  type BoundedProcessResult,
  createProcessEnvironmentWithPath,
  runBoundedProcessEffect,
} from "./process.js";
import type { JscpdReportDecision, JscpdReportErrorCode } from "./types.js";

export type { JscpdReportDecision } from "./types.js";

const JSCPD_EXECUTION_TIMEOUT_MS = 30_000;
const JSCPD_MAX_OUTPUT_BYTES = 64 * 1_024;
const JSCPD_MAX_REPORT_BYTES = 16 * 1_024 * 1_024;
const JSCPD_REPORT_CONSUMPTION_TIMEOUT_MS = 2_000;
const JSCPD_WORKSPACE_CLEANUP_TIMEOUT_MS = 2_000;

const TEMPORARY_PREFIX = "pi-jscpd-";
const MAX_ARGUMENT_COUNT = 256;
const MAX_ARGUMENT_BYTES = 16 * 1_024;
const MAX_TOTAL_ARGUMENT_BYTES = 64 * 1_024;
const MAX_PATH_BYTES = 16 * 1_024;
const MAX_CONFIGURED_TIMEOUT_MS = 5 * 60_000;
const MAX_CONFIGURED_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIGURED_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_CONSUMPTION_TIMEOUT_MS = 30_000;

type JobTermination = "cancelled" | "invalidated" | "disposed";

export interface JscpdReportTarget {
  readonly directory: string;
  readonly reportPath: string;
}

export interface JscpdRunRequest<T> {
  /** A capability-resolved executable name or absolute executable path. */
  executable: string;
  /** The explicit project working directory. */
  cwd: string;
  /** A stable PATH used to resolve a command name. Defaults to the current process PATH. */
  path?: string;
  signal?: AbortSignal;
  /** Per-run extension timeout override loaded from trusted configuration. */
  timeoutMs?: number;
  /** Build shell-free CLI tokens around the adapter-owned report directory and fixed file path. */
  createArguments(target: JscpdReportTarget): readonly string[];
  /** Nonzero clone-positive exits accepted only when they also yield an accepted findings report. */
  reportExitCodes?: readonly number[];
  /** Validate and consume bounded report bytes before their temporary directory is removed. */
  consumeReportEffect: (
    report: Uint8Array,
  ) => Effect.Effect<JscpdReportDecision<T>, never, JscpdFileSystem>;
}

export type JscpdRunFailureReason =
  | "invalid-request"
  | "service-disposed"
  | "temporary-directory"
  | "unsafe-temporary-path"
  | "argument-construction"
  | "spawn-failed"
  | "nonzero-exit"
  | "output-limit"
  | "invalid-report"
  | "report-read-failed"
  | "report-too-large"
  | "consumer-failed"
  | "consumer-timed-out"
  | "cleanup-failed"
  | "internal-error";

export type JscpdRunResult<T> =
  | { status: "report"; value: T }
  | { status: "no-findings"; value?: T }
  | { status: "no-report" }
  | { status: "cancelled" }
  | { status: "invalidated" }
  | { status: "timed-out"; timeoutMs: number }
  | {
      status: "failed";
      reason: JscpdRunFailureReason;
      exitCode?: number;
      reportError?: JscpdReportErrorCode;
    };

interface JscpdEffectService {
  run<T>(
    request: JscpdRunRequest<T>,
  ): Effect.Effect<JscpdRunResult<T>, never, JscpdProcess | JscpdFileSystem>;
  invalidate(): Effect.Effect<void>;
  dispose(): Effect.Effect<void>;
}

export const JscpdAdapter = Context.GenericTag<JscpdEffectService>("pi-jscpd/effect/JscpdAdapter");

export interface JscpdService {
  runEffect<T>(
    request: JscpdRunRequest<T>,
  ): Effect.Effect<JscpdRunResult<T>, never, JscpdProcess | JscpdFileSystem>;
  invalidate(): void;
  disposeEffect(): Effect.Effect<void>;
}

export interface JscpdServiceOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxReportBytes?: number;
  reportConsumptionTimeoutMs?: number;
  /** Primarily for deterministic tests; no directory is created until run is called. */
  temporaryRoot?: string;
  /** Primarily for deterministic cleanup-timeout tests. */
  workspaceCleanupTimeoutMs?: number;
}

interface ResolvedServiceOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  maxReportBytes: number;
  reportConsumptionTimeoutMs: number;
  temporaryRoot: string;
  workspaceCleanupTimeoutMs: number;
}

interface EffectJob {
  readonly request: JscpdRunRequest<unknown>;
  readonly controller: AbortController;
  detachCallerAbort: () => void;
  termination?: JobTermination;
}

interface ReportWorkspace extends JscpdReportTarget {}

type WorkspaceResult =
  | { ok: true; workspace: ReportWorkspace; cleanupPath: string }
  | {
      ok: false;
      reason: "temporary-directory" | "unsafe-temporary-path";
      cleanupPath?: string;
    };

type ReportBytesResult =
  | { status: "bytes"; bytes: Uint8Array }
  | { status: "no-report" }
  | {
      status: "failed";
      reason: "invalid-report" | "report-read-failed" | "report-too-large";
    };

type ConsumptionResult<T> =
  | { status: "completed"; decision: JscpdReportDecision<T> }
  | { status: "cancelled" }
  | { status: "failed" }
  | { status: "timed-out" };

export function createJscpdService(options: JscpdServiceOptions = {}): JscpdService {
  return new DefaultJscpdService(resolveServiceOptions(options));
}

/** Scoped Effect service used by later application slices without a Promise facade. */
export function createJscpdLayer(options: JscpdServiceOptions = {}) {
  return Layer.scoped(
    JscpdAdapter,
    Effect.acquireRelease(
      Effect.sync(() => new DefaultJscpdService(resolveServiceOptions(options))),
      (owner) => owner.disposeEffect(),
    ).pipe(Effect.map(effectServiceFor)),
  );
}

class DefaultJscpdService implements JscpdService {
  readonly #options: ResolvedServiceOptions;
  readonly #semaphore = Effect.unsafeMakeSemaphore(1);
  readonly #jobs = new Set<EffectJob>();
  #disposed = false;

  constructor(options: ResolvedServiceOptions) {
    this.#options = options;
  }

  runEffect<T>(
    request: JscpdRunRequest<T>,
  ): Effect.Effect<JscpdRunResult<T>, never, JscpdProcess | JscpdFileSystem> {
    return Effect.suspend(() => {
      if (this.#disposed) return Effect.succeed(serviceDisposedResult());
      if (!isValidRunRequest(request)) {
        return Effect.succeed({ status: "failed", reason: "invalid-request" } as const);
      }
      if (request.signal?.aborted) return Effect.succeed({ status: "cancelled" } as const);

      const job = this.#createJob(request as JscpdRunRequest<unknown>);
      this.#jobs.add(job);
      return this.#runJobEffect(job).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ status: "failed", reason: "internal-error" } as const),
        ),
      ) as Effect.Effect<JscpdRunResult<T>, never, JscpdProcess | JscpdFileSystem>;
    });
  }

  #runJobEffect(
    job: EffectJob,
  ): Effect.Effect<JscpdRunResult<unknown>, never, JscpdProcess | JscpdFileSystem> {
    return Effect.acquireUseRelease(
      Effect.succeed(job),
      () =>
        Effect.raceFirst(
          this.#semaphore.withPermits(1)(
            Effect.suspend(() => {
              const lifecycleResult = lifecycleResultFor(job);
              return lifecycleResult ? Effect.succeed(lifecycleResult) : this.#executeEffect(job);
            }),
          ),
          awaitJobTermination(job),
        ),
      () =>
        Effect.sync(() => {
          job.detachCallerAbort();
          this.#jobs.delete(job);
        }),
    );
  }

  invalidate(): void {
    if (this.#disposed) return;
    for (const job of this.#jobs) this.#terminateJob(job, "invalidated");
  }

  invalidateEffect(): Effect.Effect<void> {
    return Effect.sync(() => this.invalidate());
  }

  disposeEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.#disposed) {
        this.#disposed = true;
        for (const job of this.#jobs) this.#terminateJob(job, "disposed");
      }
      return this.#semaphore.withPermits(1)(Effect.void);
    });
  }

  #createJob(request: JscpdRunRequest<unknown>): EffectJob {
    const controller = new AbortController();
    const job: EffectJob = {
      request,
      controller,
      detachCallerAbort: () => undefined,
    };
    const cancel = () => this.#terminateJob(job, "cancelled");
    request.signal?.addEventListener("abort", cancel, { once: true });
    job.detachCallerAbort = () => request.signal?.removeEventListener("abort", cancel);
    if (request.signal?.aborted) cancel();
    return job;
  }

  #terminateJob(job: EffectJob, termination: JobTermination): void {
    if (job.termination) return;
    job.termination = termination;
    job.controller.abort();
  }

  #executeEffect(
    job: EffectJob,
  ): Effect.Effect<JscpdRunResult<unknown>, never, JscpdProcess | JscpdFileSystem> {
    let cleanupFailed = false;
    return Effect.acquireUseRelease(
      createReportWorkspaceEffect(job.request.cwd, this.#options.temporaryRoot),
      (workspaceResult) =>
        workspaceResult.ok
          ? this.#executeInWorkspaceEffect(job, workspaceResult.workspace)
          : Effect.succeed<JscpdRunResult<unknown>>({
              status: "failed",
              reason: workspaceResult.reason,
            }),
      (workspaceResult) => {
        if (!workspaceResult.cleanupPath) return Effect.void;
        return removeWorkspaceEffect(
          workspaceResult.cleanupPath,
          this.#options.workspaceCleanupTimeoutMs,
        ).pipe(
          Effect.tap((cleaned) =>
            Effect.sync(() => {
              cleanupFailed = !cleaned;
            }),
          ),
        );
      },
    ).pipe(
      Effect.map((result) =>
        cleanupFailed ? { status: "failed", reason: "cleanup-failed" } : result,
      ),
    );
  }

  #executeInWorkspaceEffect(
    job: EffectJob,
    workspace: ReportWorkspace,
  ): Effect.Effect<JscpdRunResult<unknown>, never, JscpdProcess | JscpdFileSystem> {
    return Effect.gen(this, function* () {
      const lifecycleResult = lifecycleResultFor(job);
      if (lifecycleResult) return lifecycleResult;

      const args = createValidatedArguments(job.request, workspace);
      if (!args) return { status: "failed", reason: "argument-construction" } as const;

      const timeoutMs = requestTimeoutMs(job.request.timeoutMs, this.#options.timeoutMs);
      const processResult = yield* runBoundedProcessEffect({
        stage: "scan",
        executable: job.request.executable,
        args,
        cwd: job.request.cwd,
        environment: createProcessEnvironmentWithPath(job.request.path ?? process.env.PATH ?? ""),
        timeoutMs,
        maxOutputBytes: this.#options.maxOutputBytes,
      });
      const afterProcessLifecycle = lifecycleResultFor(job);
      if (afterProcessLifecycle) return afterProcessLifecycle;

      const processFailure = processFailureResult(
        processResult,
        timeoutMs,
        job.request.reportExitCodes,
      );
      if (processFailure) return processFailure;
      const reportExitCode = deferredReportExitCode(processResult);

      const report = yield* readBoundedReportEffect(
        workspace.reportPath,
        this.#options.maxReportBytes,
      );
      if (report.status !== "bytes") return reportReadResult(report, reportExitCode);

      const consumed = yield* consumeReportEffect(
        job.request.consumeReportEffect,
        report.bytes,
        this.#options.reportConsumptionTimeoutMs,
      );
      const afterConsumptionLifecycle = lifecycleResultFor(job);
      if (afterConsumptionLifecycle) return afterConsumptionLifecycle;
      return validateReportExit(consumptionResult(consumed), reportExitCode);
    });
  }
}

function effectServiceFor(owner: DefaultJscpdService): JscpdEffectService {
  return {
    run: (request) => owner.runEffect(request),
    invalidate: () => owner.invalidateEffect(),
    dispose: () => owner.disposeEffect(),
  };
}

function awaitJobTermination(job: EffectJob): Effect.Effect<JscpdRunResult<never>> {
  const current = lifecycleResultFor(job);
  if (current) return Effect.succeed(current);
  return Effect.async((resume) => {
    const terminated = () =>
      resume(Effect.succeed(lifecycleResultFor(job) ?? serviceDisposedResult()));
    job.controller.signal.addEventListener("abort", terminated, { once: true });
    if (job.controller.signal.aborted) terminated();
    return Effect.sync(() => job.controller.signal.removeEventListener("abort", terminated));
  });
}

function resolveServiceOptions(options: JscpdServiceOptions): ResolvedServiceOptions {
  const resolved = {
    timeoutMs: withDefault(options.timeoutMs, JSCPD_EXECUTION_TIMEOUT_MS),
    maxOutputBytes: withDefault(options.maxOutputBytes, JSCPD_MAX_OUTPUT_BYTES),
    maxReportBytes: withDefault(options.maxReportBytes, JSCPD_MAX_REPORT_BYTES),
    reportConsumptionTimeoutMs: withDefault(
      options.reportConsumptionTimeoutMs,
      JSCPD_REPORT_CONSUMPTION_TIMEOUT_MS,
    ),
    temporaryRoot: withDefault(options.temporaryRoot, tmpdir()),
    workspaceCleanupTimeoutMs: withDefault(
      options.workspaceCleanupTimeoutMs,
      JSCPD_WORKSPACE_CLEANUP_TIMEOUT_MS,
    ),
  };

  assertBoundedOption(resolved.timeoutMs, MAX_CONFIGURED_TIMEOUT_MS);
  assertBoundedOption(resolved.maxOutputBytes, MAX_CONFIGURED_OUTPUT_BYTES);
  assertBoundedOption(resolved.maxReportBytes, MAX_CONFIGURED_REPORT_BYTES);
  assertBoundedOption(resolved.reportConsumptionTimeoutMs, MAX_CONFIGURED_CONSUMPTION_TIMEOUT_MS);
  assertBoundedOption(resolved.workspaceCleanupTimeoutMs, MAX_CONFIGURED_CONSUMPTION_TIMEOUT_MS);
  if (!isSafeAbsolutePath(resolved.temporaryRoot)) throwInvalidServiceOptions();
  return resolved;
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function assertBoundedOption(value: number, maximum: number): void {
  if (!isBoundedPositiveInteger(value, maximum)) {
    throwInvalidServiceOptions();
  }
}

function throwInvalidServiceOptions(): never {
  throw new TypeError("Invalid bounded jscpd service options.");
}

function isValidRunRequest<T>(request: JscpdRunRequest<T>): boolean {
  return (
    request !== null &&
    typeof request === "object" &&
    isSafeBoundedText(request.executable, MAX_PATH_BYTES, false) &&
    isSafeAbsolutePath(request.cwd) &&
    (request.path === undefined || isSafeBoundedText(request.path, MAX_PATH_BYTES, true)) &&
    hasValidRunControls(request) &&
    typeof request.createArguments === "function" &&
    typeof request.consumeReportEffect === "function"
  );
}

function createValidatedArguments(
  request: JscpdRunRequest<unknown>,
  target: JscpdReportTarget,
): readonly string[] | undefined {
  let args: readonly string[];
  try {
    args = request.createArguments(Object.freeze({ ...target }));
  } catch {
    return undefined;
  }
  if (!Array.isArray(args) || args.length > MAX_ARGUMENT_COUNT) {
    return undefined;
  }

  let totalBytes = 0;
  for (const token of args) {
    if (typeof token !== "string" || token.includes("\0")) {
      return undefined;
    }
    const tokenBytes = Buffer.byteLength(token);
    totalBytes += tokenBytes;
    if (tokenBytes > MAX_ARGUMENT_BYTES || totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
      return undefined;
    }
  }
  return [...args];
}

function createReportWorkspaceEffect(
  cwd: string,
  temporaryRoot: string,
): Effect.Effect<WorkspaceResult, never, JscpdFileSystem> {
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem.makeTempDirectory(join(temporaryRoot, TEMPORARY_PREFIX)).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed({ ok: false as const, reason: "temporary-directory" as const }),
        onSuccess: (directory) => validateReportWorkspaceEffect(filesystem, cwd, directory),
      }),
    ),
  );
}

function validateReportWorkspaceEffect(
  filesystem: JscpdFileSystemService,
  cwd: string,
  directory: string,
): Effect.Effect<WorkspaceResult> {
  return Effect.all(
    [
      filesystem.canonicalize(directory),
      filesystem.canonicalize(cwd),
      filesystem.metadata(cwd),
    ] as const,
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([ownedDirectory, projectDirectory, projectMetadata]) => {
      if (projectMetadata.kind !== "directory" || isPathInside(projectDirectory, ownedDirectory)) {
        return {
          ok: false as const,
          reason: "unsafe-temporary-path" as const,
          cleanupPath: directory,
        };
      }
      const reportPath = resolve(ownedDirectory, JSCPD_STRUCTURED_REPORT_FILE_NAME);
      if (dirname(reportPath) !== ownedDirectory) {
        return {
          ok: false as const,
          reason: "unsafe-temporary-path" as const,
          cleanupPath: directory,
        };
      }
      return {
        ok: true as const,
        workspace: { directory: ownedDirectory, reportPath },
        cleanupPath: ownedDirectory,
      };
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        reason: "temporary-directory" as const,
        cleanupPath: directory,
      }),
    ),
  );
}

function removeWorkspaceEffect(
  directory: string,
  timeoutMs: number,
): Effect.Effect<boolean, never, JscpdFileSystem> {
  const cleanup = Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem.remove(directory, true),
  ).pipe(
    Effect.as(true),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.interrupt : Effect.succeed(false),
    ),
    Effect.interruptible,
  );
  return cleanup.pipe(
    Effect.timeoutTo({
      duration: timeoutMs,
      onSuccess: (cleaned) => cleaned,
      onTimeout: () => false,
    }),
  );
}

function readBoundedReportEffect(
  reportPath: string,
  maxReportBytes: number,
): Effect.Effect<ReportBytesResult, never, JscpdFileSystem> {
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem
      .read({
        path: reportPath,
        maxBytes: maxReportBytes,
        regularFileOnly: true,
        noFollow: true,
        limitSubject: "report",
      })
      .pipe(
        Effect.match({
          onFailure: reportReadFailure,
          onSuccess: (bytes) => ({ status: "bytes" as const, bytes }),
        }),
      ),
  );
}

function reportReadFailure(error: JscpdFileSystemFailure | JscpdLimitExceeded): ReportBytesResult {
  if (error instanceof JscpdLimitExceeded) {
    return { status: "failed", reason: "report-too-large" };
  }
  if (error.reason === "missing") return { status: "no-report" };
  return error.reason === "not-regular" || error.reason === "symlink"
    ? { status: "failed", reason: "invalid-report" }
    : { status: "failed", reason: "report-read-failed" };
}

function consumeReportEffect<T>(
  consumer: JscpdRunRequest<T>["consumeReportEffect"],
  report: Uint8Array,
  timeoutMs: number,
): Effect.Effect<ConsumptionResult<T>, never, JscpdFileSystem> {
  return consumer(report).pipe(
    Effect.map(
      (decision): ConsumptionResult<T> =>
        isReportDecision(decision) ? { status: "completed", decision } : { status: "failed" },
    ),
    Effect.timeoutTo({
      duration: timeoutMs,
      onSuccess: (result) => result,
      onTimeout: (): ConsumptionResult<T> => ({ status: "timed-out" }),
    }),
  );
}

function consumptionResult<T>(consumption: ConsumptionResult<T>): JscpdRunResult<T> {
  switch (consumption.status) {
    case "completed":
      return completedConsumptionResult(consumption.decision);
    case "cancelled":
      return { status: "cancelled" };
    case "failed":
      return { status: "failed", reason: "consumer-failed" };
    case "timed-out":
      return { status: "failed", reason: "consumer-timed-out" };
  }
}

function completedConsumptionResult<T>(decision: JscpdReportDecision<T>): JscpdRunResult<T> {
  switch (decision.status) {
    case "accepted":
      return { status: "report", value: decision.value };
    case "no-findings":
      return decision.value === undefined
        ? { status: "no-findings" }
        : { status: "no-findings", value: decision.value };
    case "rejected":
      return {
        status: "failed",
        reason: "invalid-report",
        reportError: decision.reason,
      };
  }
}

function reportReadResult(
  report: Exclude<ReportBytesResult, { status: "bytes" }>,
  reportExitCode: number | undefined,
): JscpdRunResult<never> {
  if (report.status === "failed") {
    return { status: "failed", reason: report.reason };
  }
  return reportExitCode === undefined
    ? { status: "no-report" }
    : { status: "failed", reason: "nonzero-exit", exitCode: reportExitCode };
}

function validateReportExit<T>(
  result: JscpdRunResult<T>,
  reportExitCode: number | undefined,
): JscpdRunResult<T> {
  return result.status === "no-findings" && reportExitCode !== undefined
    ? { status: "failed", reason: "nonzero-exit", exitCode: reportExitCode }
    : result;
}

function processFailureResult(
  result: BoundedProcessResult,
  timeoutMs: number,
  reportExitCodes: readonly number[] | undefined,
): JscpdRunResult<never> | undefined {
  switch (result.status) {
    case "completed":
      return completedProcessFailure(result.exitCode, reportExitCodes);
    case "cancelled":
      return { status: "cancelled" };
    case "timed-out":
      return { status: "timed-out", timeoutMs };
    case "output-limit":
      return { status: "failed", reason: "output-limit" };
    case "invalid-request":
      return { status: "failed", reason: "invalid-request" };
    case "not-found":
    case "spawn-failed":
      return { status: "failed", reason: "spawn-failed" };
  }
}

function completedProcessFailure(
  exitCode: number,
  reportExitCodes: readonly number[] | undefined,
): JscpdRunResult<never> | undefined {
  if (exitCode === 0 || reportExitCodes?.includes(exitCode)) {
    return undefined;
  }
  return { status: "failed", reason: "nonzero-exit", exitCode: normalizeExitCode(exitCode) };
}

function deferredReportExitCode(result: BoundedProcessResult): number | undefined {
  return result.status === "completed" && result.exitCode !== 0
    ? normalizeExitCode(result.exitCode)
    : undefined;
}

function lifecycleResultFor(job: EffectJob): JscpdRunResult<never> | undefined {
  switch (job.termination) {
    case "cancelled":
      return { status: "cancelled" };
    case "invalidated":
      return { status: "invalidated" };
    case "disposed":
      return serviceDisposedResult();
    case undefined:
      return undefined;
  }
}

function serviceDisposedResult(): JscpdRunResult<never> {
  return { status: "failed", reason: "service-disposed" };
}

function isReportDecision<T>(value: JscpdReportDecision<T>): value is JscpdReportDecision<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.status === "no-findings" ||
      (value.status === "accepted" && Object.hasOwn(value, "value")) ||
      (value.status === "rejected" && isJscpdReportErrorCode(value.reason)))
  );
}

function requestTimeoutMs(configured: number | undefined, fallback: number): number {
  return configured ?? fallback;
}

function hasValidRunControls(request: JscpdRunRequest<unknown>): boolean {
  return hasValidRunTimeout(request.timeoutMs) && hasValidReportExitCodes(request.reportExitCodes);
}

function hasValidRunTimeout(value: number | undefined): boolean {
  return value === undefined || isBoundedPositiveInteger(value, MAX_CONFIGURED_TIMEOUT_MS);
}

function hasValidReportExitCodes(value: readonly number[] | undefined): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 8 &&
      value.every((code) => Number.isSafeInteger(code) && code > 0 && code <= 255))
  );
}

function isSafeAbsolutePath(value: string): boolean {
  return isSafeBoundedText(value, MAX_PATH_BYTES, false) && isAbsolute(value);
}

function isSafeBoundedText(value: string, maxBytes: number, allowEmpty: boolean): boolean {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function normalizeExitCode(exitCode: number): number {
  return Number.isSafeInteger(exitCode) ? exitCode : 1;
}
