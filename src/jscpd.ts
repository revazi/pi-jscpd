import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isJscpdReportErrorCode, JSCPD_STRUCTURED_REPORT_FILE_NAME } from "./jscpd-report.js";
import { createProcessEnvironmentWithPath, runBoundedProcess } from "./process.js";
import type { JscpdReportDecision, JscpdReportErrorCode } from "./types.js";

export type { JscpdReportDecision } from "./types.js";

const JSCPD_EXECUTION_TIMEOUT_MS = 30_000;
const JSCPD_MAX_OUTPUT_BYTES = 64 * 1_024;
const JSCPD_MAX_REPORT_BYTES = 16 * 1_024 * 1_024;
const JSCPD_REPORT_CONSUMPTION_TIMEOUT_MS = 2_000;

const TEMPORARY_PREFIX = "pi-jscpd-";
const MAX_ARGUMENT_COUNT = 256;
const MAX_ARGUMENT_BYTES = 16 * 1_024;
const MAX_TOTAL_ARGUMENT_BYTES = 64 * 1_024;
const MAX_PATH_BYTES = 16 * 1_024;
const REPORT_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_CONFIGURED_TIMEOUT_MS = 5 * 60_000;
const MAX_CONFIGURED_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIGURED_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_CONSUMPTION_TIMEOUT_MS = 30_000;

type JobTermination = "cancelled" | "invalidated" | "disposed";
type JobPhase = "queued" | "active" | "done";

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
  consumeReport(report: Uint8Array): JscpdReportDecision<T> | Promise<JscpdReportDecision<T>>;
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

export interface JscpdService {
  run<T>(request: JscpdRunRequest<T>): Promise<JscpdRunResult<T>>;
  invalidate(): void;
  dispose(): Promise<void>;
}

export interface JscpdServiceOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxReportBytes?: number;
  reportConsumptionTimeoutMs?: number;
  /** Primarily for deterministic tests; no directory is created until run is called. */
  temporaryRoot?: string;
}

interface ResolvedServiceOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  maxReportBytes: number;
  reportConsumptionTimeoutMs: number;
  temporaryRoot: string;
}

interface PendingJob {
  request: JscpdRunRequest<unknown>;
  resolve: (result: JscpdRunResult<unknown>) => void;
  phase: JobPhase;
  termination?: JobTermination;
  controller?: AbortController;
  detachCallerAbort: () => void;
}

interface ReportWorkspace extends JscpdReportTarget {}

type WorkspaceResult =
  | { ok: true; workspace: ReportWorkspace }
  | {
      ok: false;
      reason: "temporary-directory" | "unsafe-temporary-path" | "cleanup-failed";
    };

type ReportBytesResult =
  | { status: "bytes"; bytes: Buffer }
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

class DefaultJscpdService implements JscpdService {
  readonly #options: ResolvedServiceOptions;
  readonly #queue: PendingJob[] = [];
  #active: PendingJob | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #resolveDisposed: (() => void) | undefined;

  constructor(options: ResolvedServiceOptions) {
    this.#options = options;
  }

  run<T>(request: JscpdRunRequest<T>): Promise<JscpdRunResult<T>> {
    if (this.#disposed) {
      return Promise.resolve(serviceDisposedResult());
    }
    if (!isValidRunRequest(request)) {
      return Promise.resolve({ status: "failed", reason: "invalid-request" });
    }
    if (request.signal?.aborted) {
      return Promise.resolve({ status: "cancelled" });
    }

    return new Promise<JscpdRunResult<T>>((resolveJob) => {
      const job = this.#createPendingJob(
        request as JscpdRunRequest<unknown>,
        resolveJob as (result: JscpdRunResult<unknown>) => void,
      );
      this.#queue.push(job);
      this.#startNext();
    });
  }

  invalidate(): void {
    if (this.#disposed) {
      return;
    }
    this.#terminateQueued("invalidated");
    this.#terminateActive("invalidated");
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#disposed = true;
    this.#disposePromise = new Promise((resolveDispose) => {
      this.#resolveDisposed = resolveDispose;
    });
    this.#terminateQueued("disposed");
    this.#terminateActive("disposed");
    this.#resolveDisposeIfIdle();
    return this.#disposePromise;
  }

  #createPendingJob(
    request: JscpdRunRequest<unknown>,
    resolveJob: (result: JscpdRunResult<unknown>) => void,
  ): PendingJob {
    const job: PendingJob = {
      request,
      resolve: resolveJob,
      phase: "queued",
      detachCallerAbort: () => undefined,
    };
    const cancel = () => this.#cancelJob(job);
    request.signal?.addEventListener("abort", cancel, { once: true });
    job.detachCallerAbort = () => request.signal?.removeEventListener("abort", cancel);
    return job;
  }

  #cancelJob(job: PendingJob): void {
    if (job.phase === "done") {
      return;
    }
    if (job.phase === "queued") {
      this.#removeQueuedJob(job);
      this.#finishQueuedJob(job, { status: "cancelled" });
      this.#startNext();
      return;
    }
    this.#terminateJob(job, "cancelled");
  }

  #startNext(): void {
    if (this.#active || this.#disposed) {
      this.#resolveDisposeIfIdle();
      return;
    }

    const job = this.#queue.shift();
    if (!job) {
      return;
    }

    job.phase = "active";
    job.controller = new AbortController();
    this.#active = job;
    void this.#execute(job).then(
      (result) => this.#finishActiveJob(job, result),
      () => this.#finishActiveJob(job, { status: "failed", reason: "internal-error" }),
    );
  }

  async #execute(job: PendingJob): Promise<JscpdRunResult<unknown>> {
    const workspaceResult = await createReportWorkspace(
      job.request.cwd,
      this.#options.temporaryRoot,
    );
    if (!workspaceResult.ok) {
      return { status: "failed", reason: workspaceResult.reason };
    }

    let result: JscpdRunResult<unknown>;
    try {
      result = await this.#executeInWorkspace(job, workspaceResult.workspace);
    } catch {
      result = { status: "failed", reason: "internal-error" };
    }

    const cleaned = await removeReportWorkspace(workspaceResult.workspace.directory);
    return cleaned ? result : { status: "failed", reason: "cleanup-failed" };
  }

  async #executeInWorkspace(
    job: PendingJob,
    workspace: ReportWorkspace,
  ): Promise<JscpdRunResult<unknown>> {
    const lifecycleResult = lifecycleResultFor(job);
    if (lifecycleResult) {
      return lifecycleResult;
    }

    const args = createValidatedArguments(job.request, workspace);
    if (!args) {
      return { status: "failed", reason: "argument-construction" };
    }

    const timeoutMs = requestTimeoutMs(job.request.timeoutMs, this.#options.timeoutMs);
    const processResult = await runBoundedProcess({
      executable: job.request.executable,
      args,
      cwd: job.request.cwd,
      env: createProcessEnvironmentWithPath(job.request.path ?? process.env.PATH ?? ""),
      signal: requiredController(job).signal,
      timeoutMs,
      maxOutputBytes: this.#options.maxOutputBytes,
    });
    const afterProcessLifecycle = lifecycleResultFor(job);
    if (afterProcessLifecycle) {
      return afterProcessLifecycle;
    }

    const processFailure = processFailureResult(
      processResult,
      timeoutMs,
      job.request.reportExitCodes,
    );
    if (processFailure) {
      return processFailure;
    }
    const reportExitCode = deferredReportExitCode(processResult);

    const report = await readBoundedReport(workspace.reportPath, this.#options.maxReportBytes);
    if (report.status !== "bytes") {
      return reportReadResult(report, reportExitCode);
    }

    const consumed = await this.#consumeReport(job, report.bytes);
    return validateReportExit(consumed, reportExitCode);
  }

  async #consumeReport(job: PendingJob, report: Buffer): Promise<JscpdRunResult<unknown>> {
    const consumption = await consumeReportBounded(
      job.request.consumeReport,
      report,
      requiredController(job).signal,
      this.#options.reportConsumptionTimeoutMs,
    );
    const lifecycleResult = lifecycleResultFor(job);
    if (lifecycleResult) {
      return lifecycleResult;
    }

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

  #finishActiveJob(job: PendingJob, result: JscpdRunResult<unknown>): void {
    if (this.#active !== job || job.phase !== "active") {
      return;
    }

    const lifecycleResult = lifecycleResultFor(job);
    job.phase = "done";
    job.detachCallerAbort();
    this.#active = undefined;
    job.resolve(lifecycleResult ?? result);
    this.#startNext();
    this.#resolveDisposeIfIdle();
  }

  #terminateQueued(termination: Exclude<JobTermination, "cancelled">): void {
    for (const job of this.#queue.splice(0)) {
      job.termination = termination;
      this.#finishQueuedJob(job, lifecycleResultFor(job) ?? serviceDisposedResult());
    }
  }

  #terminateActive(termination: Exclude<JobTermination, "cancelled">): void {
    if (this.#active) {
      this.#terminateJob(this.#active, termination);
    }
  }

  #terminateJob(job: PendingJob, termination: JobTermination): void {
    if (job.termination || job.phase === "done") {
      return;
    }
    job.termination = termination;
    job.controller?.abort();
  }

  #removeQueuedJob(job: PendingJob): void {
    const index = this.#queue.indexOf(job);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  #finishQueuedJob(job: PendingJob, result: JscpdRunResult<unknown>): void {
    job.phase = "done";
    job.detachCallerAbort();
    job.resolve(result);
  }

  #resolveDisposeIfIdle(): void {
    if (this.#disposed && !this.#active && this.#queue.length === 0) {
      this.#resolveDisposed?.();
      this.#resolveDisposed = undefined;
    }
  }
}

function resolveServiceOptions(options: JscpdServiceOptions): ResolvedServiceOptions {
  const resolved = {
    timeoutMs: options.timeoutMs ?? JSCPD_EXECUTION_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? JSCPD_MAX_OUTPUT_BYTES,
    maxReportBytes: options.maxReportBytes ?? JSCPD_MAX_REPORT_BYTES,
    reportConsumptionTimeoutMs:
      options.reportConsumptionTimeoutMs ?? JSCPD_REPORT_CONSUMPTION_TIMEOUT_MS,
    temporaryRoot: options.temporaryRoot ?? tmpdir(),
  };

  assertBoundedOption(resolved.timeoutMs, MAX_CONFIGURED_TIMEOUT_MS);
  assertBoundedOption(resolved.maxOutputBytes, MAX_CONFIGURED_OUTPUT_BYTES);
  assertBoundedOption(resolved.maxReportBytes, MAX_CONFIGURED_REPORT_BYTES);
  assertBoundedOption(resolved.reportConsumptionTimeoutMs, MAX_CONFIGURED_CONSUMPTION_TIMEOUT_MS);
  if (!isSafeAbsolutePath(resolved.temporaryRoot)) {
    throwInvalidServiceOptions();
  }
  return resolved;
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
    typeof request.consumeReport === "function"
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

async function createReportWorkspace(cwd: string, temporaryRoot: string): Promise<WorkspaceResult> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(temporaryRoot, TEMPORARY_PREFIX));
    await chmod(directory, 0o700);
    const [ownedDirectory, projectDirectory, projectStats] = await Promise.all([
      realpath(directory),
      realpath(cwd),
      stat(cwd),
    ]);
    if (!projectStats.isDirectory() || isPathInside(projectDirectory, ownedDirectory)) {
      const cleaned = await removeReportWorkspace(directory);
      return { ok: false, reason: cleaned ? "unsafe-temporary-path" : "cleanup-failed" };
    }

    const reportPath = resolve(ownedDirectory, JSCPD_STRUCTURED_REPORT_FILE_NAME);
    if (dirname(reportPath) !== ownedDirectory) {
      const cleaned = await removeReportWorkspace(directory);
      return { ok: false, reason: cleaned ? "unsafe-temporary-path" : "cleanup-failed" };
    }
    return { ok: true, workspace: { directory: ownedDirectory, reportPath } };
  } catch {
    const cleaned = !directory || (await removeReportWorkspace(directory));
    return { ok: false, reason: cleaned ? "temporary-directory" : "cleanup-failed" };
  }
}

async function removeReportWorkspace(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    return true;
  } catch {
    return false;
  }
}

async function readBoundedReport(
  reportPath: string,
  maxReportBytes: number,
): Promise<ReportBytesResult> {
  const pathFailure = await inspectReportPath(reportPath);
  if (pathFailure) {
    return pathFailure;
  }

  const file = await openReportFile(reportPath);
  return file
    ? readOpenedReport(file, maxReportBytes)
    : { status: "failed", reason: "report-read-failed" };
}

async function inspectReportPath(reportPath: string): Promise<ReportBytesResult | undefined> {
  try {
    const metadata = await lstat(reportPath);
    return metadata.isFile() ? undefined : { status: "failed", reason: "invalid-report" };
  } catch (error) {
    return isErrorCode(error, "ENOENT")
      ? { status: "no-report" }
      : { status: "failed", reason: "report-read-failed" };
  }
}

async function openReportFile(reportPath: string): Promise<FileHandle | undefined> {
  try {
    return await open(reportPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
}

async function readOpenedReport(
  file: FileHandle,
  maxReportBytes: number,
): Promise<ReportBytesResult> {
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      return { status: "failed", reason: "invalid-report" };
    }
    if (metadata.size > maxReportBytes) {
      return { status: "failed", reason: "report-too-large" };
    }
    return await readReportChunks(file, maxReportBytes);
  } catch {
    return { status: "failed", reason: "report-read-failed" };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readReportChunks(
  file: FileHandle,
  maxReportBytes: number,
): Promise<ReportBytesResult> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (bytesRead <= maxReportBytes) {
    const capacity = Math.min(REPORT_READ_CHUNK_BYTES, maxReportBytes - bytesRead + 1);
    const chunk = Buffer.alloc(capacity);
    const read = await file.read(chunk, 0, capacity, null);
    if (read.bytesRead === 0) {
      return { status: "bytes", bytes: Buffer.concat(chunks, bytesRead) };
    }
    chunks.push(chunk.subarray(0, read.bytesRead));
    bytesRead += read.bytesRead;
  }
  return { status: "failed", reason: "report-too-large" };
}

async function consumeReportBounded<T>(
  consumer: JscpdRunRequest<T>["consumeReport"],
  report: Buffer,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ConsumptionResult<T>> {
  if (signal.aborted) {
    return { status: "cancelled" };
  }

  let timeoutTimer: NodeJS.Timeout | undefined;
  let detachAbort: () => void = () => undefined;
  const timeout = new Promise<ConsumptionResult<T>>((resolveTimeout) => {
    timeoutTimer = setTimeout(() => resolveTimeout({ status: "timed-out" }), timeoutMs);
  });
  const cancelled = new Promise<ConsumptionResult<T>>((resolveCancelled) => {
    const cancel = () => resolveCancelled({ status: "cancelled" });
    signal.addEventListener("abort", cancel, { once: true });
    detachAbort = () => signal.removeEventListener("abort", cancel);
  });
  const consumed: Promise<ConsumptionResult<T>> = Promise.resolve()
    .then(() => consumer(report))
    .then(
      (decision): ConsumptionResult<T> =>
        isReportDecision(decision) ? { status: "completed", decision } : { status: "failed" },
      (): ConsumptionResult<T> => ({ status: "failed" }),
    );

  try {
    return await Promise.race([consumed, timeout, cancelled]);
  } finally {
    clearTimeout(timeoutTimer);
    detachAbort();
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
  result: Awaited<ReturnType<typeof runBoundedProcess>>,
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

function deferredReportExitCode(
  result: Awaited<ReturnType<typeof runBoundedProcess>>,
): number | undefined {
  return result.status === "completed" && result.exitCode !== 0
    ? normalizeExitCode(result.exitCode)
    : undefined;
}

function lifecycleResultFor(job: PendingJob): JscpdRunResult<never> | undefined {
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

function requiredController(job: PendingJob): AbortController {
  if (!job.controller) {
    throw new Error("Internal active job invariant failed.");
  }
  return job.controller;
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

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function normalizeExitCode(exitCode: number): number {
  return Number.isSafeInteger(exitCode) ? exitCode : 1;
}
