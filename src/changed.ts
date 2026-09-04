import { Cause, Context, Effect, Layer } from "effect";
import type { JscpdAcknowledgedFinding, JscpdAcknowledgementTracker } from "./acknowledgements.js";
import type { JscpdBaselineService, JscpdBaselineState } from "./baseline.js";
import { createJscpdExecutionPath, type JscpdCapabilityService } from "./capability.js";
import type { JscpdChangedFileTracker } from "./changed-files.js";
import {
  compareJscpdCloneSnapshots,
  indexJscpdCloneReportEffect,
  type JscpdIndexedCloneGroup,
} from "./clone-identity.js";
import { DEFAULT_JSCPD_CONFIG, type JscpdConfig } from "./config.js";
import { type JscpdEffectRuntime, JscpdTestEffectRuntime } from "./effect/runtime-boundary.js";
import type { JscpdFileSystem, JscpdProcess } from "./effect/services.js";
import type { JscpdRunResult, JscpdService } from "./jscpd.js";
import { consumeJscpdV5JsonReportEffect } from "./jscpd-report.js";
import { compareText, optionalCanonicalDirectoryEffect } from "./path-utils.js";
import { presentJscpdChanged } from "./presentation.js";
import {
  adapterRunEffect,
  capabilityProbeEffect,
  capabilityUnavailableResult,
  createJscpdScanArguments,
  executionResult,
  JSCPD_CLONE_POSITIVE_EXIT_CODES,
} from "./scan.js";
import type {
  JscpdChangedUnavailableReason,
  JscpdCommandExecutor,
  JscpdExecutionResult,
  JscpdScanReport,
} from "./types.js";
import type { JscpdVerificationService } from "./verification.js";
import {
  compareAndRememberJscpdVerificationEffect,
  jscpdVerificationScopeEffect,
  withJscpdVerification,
} from "./verification.js";

export interface JscpdChangedExecutorOptions {
  readonly path?: string;
  readonly config?: () => JscpdConfig;
  readonly stateChanged?: () => void;
  /** Prefer the most actionable changed-file clone groups before applying the display cap. */
  readonly prioritizeFindings?: boolean;
  /** Ephemeral comparison state for explicit pre/post-refactor checks. */
  readonly verification?: JscpdVerificationService;
}

interface JscpdChangedWorkflowService {
  readonly execute: (
    context: Parameters<JscpdCommandExecutor["execute"]>[1],
  ) => Effect.Effect<JscpdExecutionResult, never, JscpdFileSystem | JscpdProcess>;
}

export const JscpdChangedWorkflow = Context.GenericTag<JscpdChangedWorkflowService>(
  "pi-jscpd/effect/ChangedWorkflow",
);

/** Run and compare one full-project report, then acknowledge only findings actually surfaced. */
export function createJscpdChangedExecutor(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions = {},
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdCommandExecutor {
  const workflow = changedWorkflowFor(
    capabilityService,
    service,
    baselineService,
    changedFiles,
    acknowledgements,
    options,
  );
  return {
    execute: (_invocation, context) => runtime.runPromise(workflow.execute(context)),
    executeEffect: (_invocation, context) => workflow.execute(context),
  };
}

export function createJscpdChangedWorkflowLayer(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions = {},
) {
  return Layer.succeed(
    JscpdChangedWorkflow,
    changedWorkflowFor(
      capabilityService,
      service,
      baselineService,
      changedFiles,
      acknowledgements,
      options,
    ),
  );
}

function changedWorkflowFor(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions,
): JscpdChangedWorkflowService {
  const semaphore = Effect.unsafeMakeSemaphore(1);
  return {
    execute: (context) =>
      Effect.gen(function* () {
        const scope = yield* acknowledgementScopeEffect(acknowledgements);
        const verificationScope = options.verification
          ? yield* jscpdVerificationScopeEffect(options.verification)
          : undefined;
        return yield* semaphore.withPermits(1)(
          executeChangedEffect(
            capabilityService,
            service,
            baselineService,
            changedFiles,
            acknowledgements,
            context,
            options,
            scope,
            verificationScope,
          ),
        );
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.interrupt
            : Effect.succeed(
                changedUnavailable(
                  "baseline-failed",
                  "The changed-duplication check failed safely; no findings were acknowledged.",
                ),
              ),
        ),
      ),
  };
}

function executeChangedEffect(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
  options: JscpdChangedExecutorOptions,
  scope: number,
  verificationScope: number | undefined,
): Effect.Effect<JscpdExecutionResult, never, JscpdFileSystem | JscpdProcess> {
  return Effect.gen(function* () {
    const prepared = yield* prepareChangedCheckEffect(
      baselineService,
      changedFiles,
      acknowledgements,
      options,
      scope,
    );
    if (prepared.status === "result") return prepared.result;
    const scanned = yield* scanCurrentChangesEffect(
      capabilityService,
      service,
      acknowledgements,
      context,
      options,
      prepared.config,
      scope,
    );
    if (scanned.status === "result") return scanned.result;
    return yield* compareCurrentChangesEffect(
      scanned.report,
      scanned.cwd,
      prepared.baseline,
      prepared.ownedPaths,
      acknowledgements,
      options,
      prepared.config,
      scope,
      verificationScope,
    );
  });
}

interface JscpdPreparedChangedCheck {
  readonly status: "ready";
  readonly config: JscpdConfig;
  readonly ownedPaths: readonly string[];
  readonly baseline: Extract<JscpdBaselineState, { status: "accepted" }>;
}

interface JscpdScannedChanges {
  readonly status: "ready";
  readonly cwd: string;
  readonly report: JscpdScanReport;
}

interface JscpdChangedResultStep {
  readonly status: "result";
  readonly result: JscpdExecutionResult;
}

function prepareChangedCheckEffect(
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions,
  scope: number,
): Effect.Effect<JscpdPreparedChangedCheck | JscpdChangedResultStep> {
  return Effect.gen(function* () {
    if ((yield* acknowledgementScopeEffect(acknowledgements)) !== scope) {
      return resultStep(lifecycleChanged());
    }
    const config = options.config?.() ?? DEFAULT_JSCPD_CONFIG;
    if (!config.enabled) return resultStep(disabledResult());
    const ownedPaths = yield* changedFilesEffect(changedFiles);
    if (ownedPaths.length === 0) return resultStep(noTrackedFilesResult());
    const baseline = yield* safeBaselineEffect(baselineService);
    if ((yield* acknowledgementScopeEffect(acknowledgements)) !== scope) {
      return resultStep(lifecycleChanged());
    }
    if (baseline.status !== "accepted") return resultStep(unavailableBaseline(baseline));
    if (baseline.snapshot.status !== "accepted") {
      return resultStep(
        changedUnavailable(
          "baseline-partial",
          "jscpd changed is unavailable because the accepted baseline has incomplete clone identities; no findings were acknowledged.",
        ),
      );
    }
    return Object.freeze({ status: "ready", config, ownedPaths, baseline });
  });
}

function scanCurrentChangesEffect(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  acknowledgements: JscpdAcknowledgementTracker,
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
  options: JscpdChangedExecutorOptions,
  config: JscpdConfig,
  scope: number,
): Effect.Effect<
  JscpdScannedChanges | JscpdChangedResultStep,
  never,
  JscpdFileSystem | JscpdProcess
> {
  return Effect.gen(function* () {
    const cwd = yield* optionalCanonicalDirectoryEffect(context.cwd);
    if (!cwd) return resultStep(unsupportedPathResult());
    const capability = yield* capabilityProbeEffect(capabilityService, {
      cwd,
      path: options.path,
      signal: context.signal,
    });
    if ((yield* acknowledgementScopeEffect(acknowledgements)) !== scope) {
      return resultStep(lifecycleChanged());
    }
    if (capability.status !== "available") {
      return resultStep(capabilityUnavailableResult(capability));
    }
    const run = yield* adapterRunEffect(service, {
      executable: capability.executable,
      cwd,
      path: createJscpdExecutionPath(cwd, options.path, capability.source),
      signal: context.signal,
      timeoutMs: options.config ? config.timeoutMs : undefined,
      reportExitCodes: JSCPD_CLONE_POSITIVE_EXIT_CODES,
      createArguments: ({ directory }) => createJscpdScanArguments(directory, ["."]),
      consumeReportEffect: (bytes) => consumeJscpdV5JsonReportEffect(bytes, cwd),
    });
    if ((yield* acknowledgementScopeEffect(acknowledgements)) !== scope) {
      return resultStep(lifecycleChanged());
    }
    const report = reportFromRun(run);
    return report
      ? Object.freeze({ status: "ready", cwd, report })
      : resultStep(executionResult(run, config.maxFindings));
  });
}

function compareCurrentChangesEffect(
  report: JscpdScanReport,
  cwd: string,
  baseline: Extract<JscpdBaselineState, { status: "accepted" }>,
  ownedPaths: readonly string[],
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions,
  config: JscpdConfig,
  scope: number,
  verificationScope: number | undefined,
): Effect.Effect<JscpdExecutionResult, never, JscpdFileSystem> {
  return Effect.gen(function* () {
    const revision = yield* acknowledgementRevisionEffect(acknowledgements);
    const current = yield* indexJscpdCloneReportEffect(report, cwd);
    if ((yield* acknowledgementScopeEffect(acknowledgements)) !== scope) return lifecycleChanged();
    if (current.status !== "accepted") {
      return changedUnavailable(
        "identity-partial",
        "jscpd changed could not derive complete identities from the current scan; no findings were acknowledged.",
      );
    }
    const comparison = compareJscpdCloneSnapshots(baseline.snapshot, current);
    const changedPathSet = new Set(ownedPaths);
    const acknowledged = new Set(
      (yield* acknowledgementFindingsEffect(acknowledgements)).map(
        ({ fingerprint }) => fingerprint,
      ),
    );
    const { active, candidates } = selectChangedCandidates(
      current.groups,
      comparison.new,
      changedPathSet,
      acknowledged,
      options.prioritizeFindings ?? false,
    );
    const presented = presentJscpdChanged(
      candidates.map(({ group }) => group.clone),
      changedPathSet,
      config.maxFindings,
      comparison.ambiguous.length,
    );
    const surfaced = candidates
      .slice(0, presented.findings.length)
      .map(({ acknowledgement }) => acknowledgement);
    if (yield* acknowledgementReconcileEffect(acknowledgements, revision, active, surfaced)) {
      options.stateChanged?.();
    }
    if (!options.verification || verificationScope === undefined) return presented;
    const verification = yield* compareAndRememberJscpdVerificationEffect(
      options.verification,
      "changed",
      ".",
      current,
      verificationScope,
    );
    return withJscpdVerification(presented, verification);
  });
}

function acknowledgementScopeEffect(service: JscpdAcknowledgementTracker): Effect.Effect<number> {
  return service.scopeEffect ?? Effect.sync(() => service.scope());
}

function acknowledgementRevisionEffect(
  service: JscpdAcknowledgementTracker,
): Effect.Effect<number> {
  return service.revisionEffect ?? Effect.sync(() => service.revision());
}

function acknowledgementFindingsEffect(
  service: JscpdAcknowledgementTracker,
): Effect.Effect<readonly JscpdAcknowledgedFinding[]> {
  return service.findingsEffect ?? Effect.sync(() => service.findings());
}

function acknowledgementReconcileEffect(
  service: JscpdAcknowledgementTracker,
  expectedRevision: number,
  active: readonly JscpdAcknowledgedFinding[],
  surfaced: readonly JscpdAcknowledgedFinding[],
): Effect.Effect<boolean> {
  return (
    service.reconcileEffect?.(expectedRevision, active, surfaced) ??
    Effect.sync(() => service.reconcile(expectedRevision, active, surfaced))
  );
}

function changedFilesEffect(service: JscpdChangedFileTracker): Effect.Effect<readonly string[]> {
  return service.filesEffect ?? Effect.sync(() => service.files());
}

function safeBaselineEffect(service: JscpdBaselineService): Effect.Effect<JscpdBaselineState> {
  const wait =
    service.waitEffect ??
    Effect.tryPromise({
      try: () => service.wait(),
      catch: () => ({ status: "failed", stage: "scan", reason: "internal-error" }) as const,
    });
  return wait.pipe(Effect.catchAll((state) => Effect.succeed(state)));
}

function resultStep(result: JscpdExecutionResult): JscpdChangedResultStep {
  return Object.freeze({ status: "result", result });
}

function disabledResult(): JscpdExecutionResult {
  return Object.freeze({
    status: "unavailable",
    reason: "disabled",
    message: "jscpd scanning is disabled for this session. Run /jscpd on to re-enable it.",
  });
}

function noTrackedFilesResult(): JscpdExecutionResult {
  const message = "jscpd changed: no session-owned changed files are tracked; no scan ran.";
  return Object.freeze({
    status: "changed",
    outcome: "clean",
    scanPerformed: false,
    message,
    terminalMessage: message,
    findings: Object.freeze([]),
    omittedFindings: 0,
    ambiguousFindings: 0,
  });
}

function unsupportedPathResult(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "unsupported-path",
    message: "jscpd changed requires an available project working directory; no scan ran.",
  });
}

function reportFromRun(result: JscpdRunResult<JscpdScanReport>): JscpdScanReport | undefined {
  if (result.status === "report") return result.value;
  if (result.status === "no-findings") return result.value;
  return undefined;
}

function unavailableBaseline(state: JscpdBaselineState): JscpdExecutionResult {
  switch (state.status) {
    case "unstarted":
    case "pending":
      return changedUnavailable(
        "baseline-pending",
        "jscpd changed has no settled pre-session baseline yet; no current findings were classified or acknowledged.",
      );
    case "unavailable":
      return changedUnavailable(
        "baseline-unavailable",
        "jscpd changed has no available pre-session baseline; no current findings were classified or acknowledged.",
      );
    case "partial":
      return changedUnavailable(
        "baseline-partial",
        "jscpd changed cannot classify restored changes without the ephemeral pre-session baseline; run a full /jscpd scan for current repository results.",
      );
    case "cancelled":
      return changedUnavailable(
        "baseline-cancelled",
        "The pre-session baseline was cancelled; no current findings were classified or acknowledged.",
      );
    case "timed-out":
      return changedUnavailable(
        "baseline-timed-out",
        "The pre-session baseline timed out; no current findings were classified or acknowledged.",
      );
    case "failed":
      return changedUnavailable(
        "baseline-failed",
        "The pre-session baseline failed safely; no current findings were classified or acknowledged.",
      );
    case "accepted":
      return changedUnavailable(
        "baseline-failed",
        "The pre-session baseline could not be used; no findings were classified or acknowledged.",
      );
  }
}

interface JscpdChangedCandidate {
  readonly group: JscpdIndexedCloneGroup;
  readonly acknowledgement: JscpdAcknowledgedFinding;
}

function selectChangedCandidates(
  groups: readonly JscpdIndexedCloneGroup[],
  newClones: readonly JscpdScanReport["clonePairs"][number][],
  changedPaths: ReadonlySet<string>,
  acknowledged: ReadonlySet<string>,
  prioritize: boolean,
): {
  readonly active: readonly JscpdAcknowledgedFinding[];
  readonly candidates: readonly JscpdChangedCandidate[];
} {
  const newGroups = new Set(newClones);
  const active: JscpdAcknowledgedFinding[] = [];
  const candidates: JscpdChangedCandidate[] = [];
  for (const group of groups) {
    if (!group.fingerprint) continue;
    const acknowledgement = acknowledgedFinding(group.fingerprint, group.clone);
    active.push(acknowledgement);
    if (!newGroups.has(group.clone)) continue;
    if (!group.clone.occurrences.some(({ path }) => changedPaths.has(path))) continue;
    if (acknowledged.has(group.fingerprint)) continue;
    candidates.push({ group, acknowledgement });
  }
  if (prioritize)
    candidates.sort((left, right) => compareChangedCandidate(left, right, changedPaths));
  return Object.freeze({ active: Object.freeze(active), candidates: Object.freeze(candidates) });
}

function compareChangedCandidate(
  left: JscpdChangedCandidate,
  right: JscpdChangedCandidate,
  changedPaths: ReadonlySet<string>,
): number {
  const changedDifference =
    changedOccurrenceCount(right.group.clone, changedPaths) -
    changedOccurrenceCount(left.group.clone, changedPaths);
  if (changedDifference !== 0) return changedDifference;
  const lineDifference = right.group.clone.lines - left.group.clone.lines;
  if (lineDifference !== 0) return lineDifference;
  const tokenDifference = right.group.clone.tokens - left.group.clone.tokens;
  if (tokenDifference !== 0) return tokenDifference;
  return compareText(cloneLocationKey(left.group.clone), cloneLocationKey(right.group.clone));
}

function changedOccurrenceCount(
  clone: JscpdScanReport["clonePairs"][number],
  changedPaths: ReadonlySet<string>,
): number {
  return clone.occurrences.filter(({ path }) => changedPaths.has(path)).length;
}

function cloneLocationKey(clone: JscpdScanReport["clonePairs"][number]): string {
  return clone.occurrences
    .map(
      ({ path, start, end }) => `${path}:${start.line}:${start.column}:${end.line}:${end.column}`,
    )
    .join("\0");
}

function acknowledgedFinding(
  fingerprint: string,
  clone: JscpdScanReport["clonePairs"][number],
): JscpdAcknowledgedFinding {
  const paths = clone.occurrences.map(({ path }) => path).sort(compareText) as [string, string];
  return Object.freeze({ fingerprint, paths: Object.freeze(paths) });
}

function lifecycleChanged(): JscpdExecutionResult {
  return changedUnavailable(
    "baseline-cancelled",
    "The changed-duplication check was cancelled by a session branch transition; no findings were acknowledged.",
  );
}

function changedUnavailable(
  reason: JscpdChangedUnavailableReason,
  message: string,
): JscpdExecutionResult {
  return Object.freeze({ status: "changed-unavailable", reason, message });
}
