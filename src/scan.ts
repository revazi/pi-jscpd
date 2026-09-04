import { isAbsolute, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  createJscpdExecutionPath,
  type JscpdCapabilityRequest,
  type JscpdCapabilityResult,
  type JscpdCapabilityService,
} from "./capability.js";
import { indexJscpdCloneReportEffect } from "./clone-identity.js";
import { DEFAULT_JSCPD_CONFIG, type JscpdConfig } from "./config.js";
import { JscpdFileSystemLive } from "./effect/filesystem.js";
import { runFileSystemEffectAtApplicationBoundary } from "./effect/runtime-boundary.js";
import { JscpdFileSystem, type JscpdProcess } from "./effect/services.js";
import type {
  JscpdRunFailureReason,
  JscpdRunRequest,
  JscpdRunResult,
  JscpdService,
} from "./jscpd.js";
import {
  consumeJscpdV5JsonReport,
  consumeJscpdV5JsonReportEffect,
  JSCPD_STRUCTURED_REPORTER,
} from "./jscpd-report.js";
import { isPathInside, optionalCanonicalDirectoryEffect } from "./path-utils.js";
import { presentJscpdScan } from "./presentation.js";
import { JscpdProcessLive } from "./process.js";
import type {
  JscpdCommandExecutor,
  JscpdExecutionResult,
  JscpdReportErrorCode,
  JscpdScanFailureReason,
  JscpdScanReport,
  JscpdUnavailableResult,
} from "./types.js";
import type { JscpdVerificationService } from "./verification.js";
import {
  compareAndRememberJscpdVerificationEffect,
  jscpdVerificationScopeEffect,
  withJscpdVerification,
} from "./verification.js";

export const JSCPD_CLONE_POSITIVE_EXIT_CODES = [1] as const;

export interface JscpdScanExecutorOptions {
  /** Stable PATH override for deterministic tests; normal Pi execution uses the session PATH. */
  path?: string;
  /** Current trusted extension configuration; omitted by isolated adapter tests. */
  config?: () => JscpdConfig;
  /** Ephemeral comparison state for explicit pre/post-refactor scans. */
  verification?: JscpdVerificationService;
}

interface ResolvedScanScopes {
  readonly cwd: string;
  readonly targets: readonly string[];
}

type ScopeResolution =
  | { ok: true; value: ResolvedScanScopes }
  | { ok: false; result: JscpdExecutionResult };

interface JscpdScanWorkflowService {
  readonly execute: (
    invocation: Parameters<JscpdCommandExecutor["execute"]>[0],
    context: Parameters<JscpdCommandExecutor["execute"]>[1],
  ) => Effect.Effect<JscpdExecutionResult, never, JscpdFileSystem | JscpdProcess>;
}

export const JscpdScanWorkflow = Context.GenericTag<JscpdScanWorkflowService>(
  "pi-jscpd/effect/ScanWorkflow",
);

/** Connect capability probing, safe scopes, the bounded adapter, strict report parsing, and views. */
export function createJscpdScanExecutor(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  options: JscpdScanExecutorOptions = {},
): JscpdCommandExecutor {
  const workflow = scanWorkflowFor(capabilityService, service, options);
  return {
    execute: (invocation, context) =>
      runFileSystemEffectAtApplicationBoundary(
        workflow.execute(invocation, context).pipe(Effect.provide(JscpdProcessLive)),
      ),
    executeEffect: (invocation, context) =>
      workflow
        .execute(invocation, context)
        .pipe(Effect.provide(JscpdProcessLive), Effect.provide(JscpdFileSystemLive)),
  };
}

export function createJscpdScanWorkflowLayer(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  options: JscpdScanExecutorOptions = {},
) {
  return Layer.succeed(JscpdScanWorkflow, scanWorkflowFor(capabilityService, service, options));
}

function scanWorkflowFor(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  options: JscpdScanExecutorOptions,
): JscpdScanWorkflowService {
  return {
    execute: (invocation, context) =>
      Effect.suspend(() => {
        const config = options.config?.() ?? DEFAULT_JSCPD_CONFIG;
        if (!config.enabled) return Effect.succeed(disabledResult());
        return Effect.gen(function* () {
          const verificationScope = options.verification
            ? yield* jscpdVerificationScopeEffect(options.verification)
            : undefined;
          const scopes = yield* resolveScanScopesEffect(context.cwd, invocation.args);
          if (!scopes.ok) return scopes.result;
          const capability = yield* capabilityProbeEffect(capabilityService, {
            cwd: scopes.value.cwd,
            path: options.path,
            signal: context.signal,
          });
          if (capability.status !== "available") return capabilityUnavailableResult(capability);
          const scan = yield* adapterRunEffect(service, {
            executable: capability.executable,
            cwd: scopes.value.cwd,
            path: createJscpdExecutionPath(scopes.value.cwd, options.path, capability.source),
            signal: context.signal,
            timeoutMs: options.config ? config.timeoutMs : undefined,
            reportExitCodes: JSCPD_CLONE_POSITIVE_EXIT_CODES,
            createArguments: ({ directory }) =>
              createJscpdScanArguments(directory, scopes.value.targets),
            consumeReport: (bytes) => consumeJscpdV5JsonReport(bytes, scopes.value.cwd),
            consumeReportEffect: (bytes) => consumeJscpdV5JsonReportEffect(bytes, scopes.value.cwd),
          });
          return yield* executionResultWithVerificationEffect(
            scan,
            config.maxFindings,
            scopes.value,
            options.verification,
            verificationScope,
          );
        });
      }),
  };
}

/** User tokens are scopes only; all reporter controls are extension-owned and precede `--`. */
export function createJscpdScanArguments(
  reportDirectory: string,
  targets: readonly string[],
): readonly string[] {
  return [
    "--reporters",
    JSCPD_STRUCTURED_REPORTER,
    "--output",
    reportDirectory,
    "--absolute",
    "--",
    ...targets,
  ];
}

function resolveScanScopesEffect(
  cwd: string,
  requested: readonly string[],
): Effect.Effect<ScopeResolution, never, JscpdFileSystem> {
  if (!isAbsolute(cwd)) return Effect.succeed(unavailableProjectScope());
  return optionalCanonicalDirectoryEffect(cwd).pipe(
    Effect.flatMap((projectDirectory) => {
      if (!projectDirectory) return Effect.succeed(unavailableProjectScope());
      const requestedTargets = requested.length === 0 ? ["."] : requested;
      return resolveScanTargetsEffect(cwd, projectDirectory, requestedTargets);
    }),
  );
}

function resolveScanTargetsEffect(
  cwd: string,
  projectDirectory: string,
  requestedTargets: readonly string[],
): Effect.Effect<ScopeResolution, never, JscpdFileSystem> {
  return Effect.gen(function* () {
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const token of requestedTargets) {
      const resolved = yield* resolveScanScopeEffect(cwd, projectDirectory, token);
      if (!resolved.ok) return resolved;
      if (!seen.has(resolved.target)) {
        seen.add(resolved.target);
        targets.push(resolved.target);
      }
    }
    return { ok: true, value: { cwd: projectDirectory, targets } } as const;
  });
}

function resolveScanScopeEffect(
  inputCwd: string,
  projectDirectory: string,
  token: string,
): Effect.Effect<
  { ok: true; target: string } | { ok: false; result: JscpdExecutionResult },
  never,
  JscpdFileSystem
> {
  const lexicalCandidate = resolve(inputCwd, token);
  if (!isPathInside(resolve(inputCwd), lexicalCandidate)) {
    return Effect.succeed(
      pathFailure("unsafe-path", "The requested scan scope is outside the project; no scan ran."),
    );
  }
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem.canonicalize(lexicalCandidate).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed(
            pathFailure(
              "unsupported-path",
              "A requested scan scope does not exist or is not accessible; no scan ran.",
            ),
          ),
        onSuccess: (canonicalCandidate) => {
          if (!isPathInside(projectDirectory, canonicalCandidate)) {
            return Effect.succeed(
              pathFailure(
                "unsafe-path",
                "The requested scan scope resolves outside the project; no scan ran.",
              ),
            );
          }
          return filesystem.metadata(canonicalCandidate).pipe(
            Effect.match({
              onFailure: () =>
                pathFailure(
                  "unsupported-path",
                  "A requested scan scope does not exist or is not accessible; no scan ran.",
                ),
              onSuccess: (metadata) => {
                if (metadata.kind !== "file" && metadata.kind !== "directory") {
                  return pathFailure(
                    "unsupported-path",
                    "A requested scan scope is not a regular file or directory; no scan ran.",
                  );
                }
                const projectRelative = relative(projectDirectory, canonicalCandidate);
                return {
                  ok: true,
                  target: projectRelative === "" ? "." : toPortablePath(projectRelative),
                } as const;
              },
            }),
          );
        },
      }),
    ),
  );
}

function executionResultWithVerificationEffect(
  scan: JscpdRunResult<JscpdScanReport>,
  maxFindings: number,
  scopes: ResolvedScanScopes,
  service: JscpdVerificationService | undefined,
  expectedScope: number | undefined,
): Effect.Effect<JscpdExecutionResult, never, JscpdFileSystem> {
  const result = executionResult(scan, maxFindings);
  if (!service || expectedScope === undefined || result.status !== "completed") {
    return Effect.succeed(result);
  }
  const report = successfulReport(scan);
  if (!report) return Effect.succeed(result);
  return indexJscpdCloneReportEffect(report, scopes.cwd).pipe(
    Effect.flatMap((snapshot) =>
      compareAndRememberJscpdVerificationEffect(
        service,
        "project",
        JSON.stringify(scopes.targets),
        snapshot,
        expectedScope,
      ),
    ),
    Effect.map((verification) => withJscpdVerification(result, verification)),
  );
}

export function capabilityProbeEffect(
  service: JscpdCapabilityService,
  request: JscpdCapabilityRequest,
): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess> {
  if (service.probeEffect) return service.probeEffect(request);
  return Effect.tryPromise({
    try: () => service.probe(request),
    catch: () => ({ status: "failed", executable: "jscpd", reason: "execution-error" }) as const,
  }).pipe(Effect.catchAll((result) => Effect.succeed(result)));
}

export function adapterRunEffect<T>(
  service: JscpdService,
  request: JscpdRunRequest<T>,
): Effect.Effect<JscpdRunResult<T>, never, JscpdProcess | JscpdFileSystem> {
  if (service.runEffect) return service.runEffect(request);
  return Effect.tryPromise({
    try: () => service.run(request),
    catch: () => ({ status: "failed", reason: "internal-error" }) as const,
  }).pipe(Effect.catchAll((result) => Effect.succeed(result)));
}

function successfulReport(result: JscpdRunResult<JscpdScanReport>): JscpdScanReport | undefined {
  if (result.status === "report" || result.status === "no-findings") return result.value;
  return undefined;
}

export function executionResult(
  result: JscpdRunResult<JscpdScanReport>,
  maxFindings: number,
): JscpdExecutionResult {
  switch (result.status) {
    case "report":
      return presentJscpdScan(result.value, maxFindings);
    case "no-findings":
      return result.value
        ? presentJscpdScan(result.value, maxFindings)
        : scanFailure(
            "invalid-report",
            "jscpd produced an invalid structured report; no result was used.",
          );
    case "no-report":
      return scanFailure(
        "missing-report",
        "jscpd did not produce its structured report; no result was used.",
      );
    case "cancelled":
    case "invalidated":
      return scanFailure(
        "scan-cancelled",
        "The jscpd scan was cancelled and its temporary report was removed.",
      );
    case "timed-out":
      return scanFailure("scan-timed-out", "The jscpd scan timed out and was stopped safely.");
    case "failed":
      return adapterFailure(result.reason, result.reportError);
  }
}

function adapterFailure(
  reason: JscpdRunFailureReason,
  reportError?: JscpdReportErrorCode,
): JscpdExecutionResult {
  if (reason === "cleanup-failed") {
    return scanFailure(
      "cleanup-failed",
      "The jscpd scan ended, but temporary report cleanup could not be confirmed.",
    );
  }
  if (reason === "invalid-report" || isReportReadFailure(reason)) {
    if (reportError === "malformed-json") {
      return scanFailure(
        "malformed-report",
        "jscpd produced malformed structured JSON; no result was used.",
      );
    }
    if (reportError === "unsupported-reporter") {
      return scanFailure(
        "incompatible-report",
        "jscpd produced an incompatible structured report; v5 JSON is required.",
      );
    }
    return scanFailure(
      "invalid-report",
      "jscpd produced an invalid structured report; no result was used.",
    );
  }
  return scanFailure(
    "process-failed",
    "The jscpd scan process failed safely; child output was not included.",
  );
}

function isReportReadFailure(reason: JscpdRunFailureReason): boolean {
  return (
    reason === "report-read-failed" ||
    reason === "report-too-large" ||
    reason === "consumer-failed" ||
    reason === "consumer-timed-out"
  );
}

function scanFailure(reason: JscpdScanFailureReason, message: string): JscpdExecutionResult {
  return { status: "failed", reason, message };
}

function disabledResult(): JscpdExecutionResult {
  return Object.freeze({
    status: "unavailable",
    reason: "disabled",
    message: "jscpd scanning is disabled for this session. Run /jscpd on to re-enable it.",
  });
}

function unavailableProjectScope(): ScopeResolution {
  return pathFailure(
    "unsupported-path",
    "jscpd scan requires an available project working directory; no scan ran.",
  );
}

function pathFailure(
  reason: Extract<JscpdScanFailureReason, "unsafe-path" | "unsupported-path">,
  message: string,
): { ok: false; result: JscpdExecutionResult } {
  return { ok: false, result: scanFailure(reason, message) };
}

export function capabilityUnavailableResult(
  capability: JscpdCapabilityResult,
): JscpdUnavailableResult {
  switch (capability.status) {
    case "available":
      throw new Error("Available capability must proceed to scan execution.");
    case "missing":
      return {
        status: "unavailable",
        reason: "missing-binary",
        message:
          "jscpd scan is unavailable because the bundled analyzer could not be resolved; reinstall pi-jscpd.",
        capability,
      };
    case "incompatible":
      return {
        status: "unavailable",
        reason: "incompatible-version",
        message: `jscpd scan requires v5; ${capability.executable} reported v${capability.version}.`,
        capability,
      };
    case "cancelled":
      return {
        status: "unavailable",
        reason: "probe-cancelled",
        message: "The jscpd executable check was cancelled; no scan ran.",
        capability,
      };
    case "timed-out":
      return {
        status: "unavailable",
        reason: "probe-timed-out",
        message: "The jscpd executable check timed out; no scan ran.",
        capability,
      };
    case "failed":
      return {
        status: "unavailable",
        reason: "probe-failed",
        message: "The jscpd executable check failed safely; no scan ran.",
        capability,
      };
  }
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
