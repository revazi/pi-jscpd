import type { JscpdAcknowledgedFinding, JscpdAcknowledgementTracker } from "./acknowledgements.js";
import type { JscpdBaselineService, JscpdBaselineState } from "./baseline.js";
import type { JscpdCapabilityService } from "./capability.js";
import type { JscpdChangedFileTracker } from "./changed-files.js";
import { compareJscpdCloneSnapshots, indexJscpdCloneReport } from "./clone-identity.js";
import { DEFAULT_JSCPD_CONFIG, type JscpdConfig } from "./config.js";
import type { JscpdRunResult, JscpdService } from "./jscpd.js";
import { consumeJscpdV5JsonReport } from "./jscpd-report.js";
import { canonicalDirectory, compareText } from "./path-utils.js";
import { presentJscpdChanged } from "./presentation.js";
import {
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

export interface JscpdChangedExecutorOptions {
  readonly path?: string;
  readonly config?: () => JscpdConfig;
  readonly stateChanged?: () => void;
}

/** Run and compare one full-project report, then acknowledge only findings actually surfaced. */
export function createJscpdChangedExecutor(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  options: JscpdChangedExecutorOptions = {},
): JscpdCommandExecutor {
  let tail: Promise<void> = Promise.resolve();
  return {
    execute(_invocation, context) {
      const scope = acknowledgements.scope();
      const run = tail.then(() =>
        executeChanged(
          capabilityService,
          service,
          baselineService,
          changedFiles,
          acknowledgements,
          context,
          options,
          scope,
        ),
      );
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run.catch(() =>
        changedUnavailable(
          "baseline-failed",
          "The changed-duplication check failed safely; no findings were acknowledged.",
        ),
      );
    },
  };
}

async function executeChanged(
  capabilityService: JscpdCapabilityService,
  service: JscpdService,
  baselineService: JscpdBaselineService,
  changedFiles: JscpdChangedFileTracker,
  acknowledgements: JscpdAcknowledgementTracker,
  context: Parameters<JscpdCommandExecutor["execute"]>[1],
  options: JscpdChangedExecutorOptions,
  scope: number,
): Promise<JscpdExecutionResult> {
  if (acknowledgements.scope() !== scope) return lifecycleChanged();
  const config = options.config?.() ?? DEFAULT_JSCPD_CONFIG;
  if (!config.enabled) {
    return {
      status: "unavailable",
      reason: "disabled",
      message: "jscpd scanning is disabled for this session. Run /jscpd on to re-enable it.",
    };
  }
  const ownedPaths = changedFiles.files();
  if (ownedPaths.length === 0) {
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

  const baseline = await safeBaseline(baselineService);
  if (acknowledgements.scope() !== scope) return lifecycleChanged();
  if (baseline.status !== "accepted") return unavailableBaseline(baseline);
  if (baseline.snapshot.status !== "accepted") {
    return changedUnavailable(
      "baseline-partial",
      "jscpd changed is unavailable because the accepted baseline has incomplete clone identities; no findings were acknowledged.",
    );
  }

  const cwd = await canonicalDirectory(context.cwd);
  if (!cwd) {
    return {
      status: "failed",
      reason: "unsupported-path",
      message: "jscpd changed requires an available project working directory; no scan ran.",
    };
  }
  let capability: Awaited<ReturnType<JscpdCapabilityService["probe"]>>;
  try {
    capability = await capabilityService.probe({
      cwd,
      path: options.path,
      signal: context.signal,
    });
  } catch {
    return {
      status: "unavailable",
      reason: "probe-failed",
      message: "The jscpd executable check failed safely; no scan ran.",
    };
  }
  if (acknowledgements.scope() !== scope) return lifecycleChanged();
  if (capability.status !== "available") return capabilityUnavailableResult(capability);

  let run: JscpdRunResult<JscpdScanReport>;
  try {
    run = await service.run<JscpdScanReport>({
      executable: capability.executable,
      cwd,
      path: options.path,
      signal: context.signal,
      timeoutMs: options.config ? config.timeoutMs : undefined,
      reportExitCodes: JSCPD_CLONE_POSITIVE_EXIT_CODES,
      createArguments: ({ directory }) => createJscpdScanArguments(directory, ["."]),
      consumeReport: (bytes) => consumeJscpdV5JsonReport(bytes, cwd),
    });
  } catch {
    return {
      status: "failed",
      reason: "process-failed",
      message: "The jscpd scan process failed safely; child output was not included.",
    };
  }
  if (acknowledgements.scope() !== scope) return lifecycleChanged();
  const report = reportFromRun(run);
  if (!report) return executionResult(run, config.maxFindings);

  const revision = acknowledgements.revision();
  const current = await indexJscpdCloneReport(report, cwd);
  if (acknowledgements.scope() !== scope) return lifecycleChanged();
  if (current.status !== "accepted") {
    return changedUnavailable(
      "identity-partial",
      "jscpd changed could not derive complete identities from the current scan; no findings were acknowledged.",
    );
  }
  const comparison = compareJscpdCloneSnapshots(baseline.snapshot, current);
  const newGroups = new Set(comparison.new);
  const changedPathSet = new Set(ownedPaths);
  const active = current.groups.flatMap((group) =>
    group.fingerprint ? [acknowledgedFinding(group.fingerprint, group.clone)] : [],
  );
  const candidates = current.groups.flatMap((group) => {
    if (!group.fingerprint || !newGroups.has(group.clone)) return [];
    if (!group.clone.occurrences.some(({ path }) => changedPathSet.has(path))) return [];
    if (acknowledgements.has(group.fingerprint)) return [];
    return [{ group, acknowledgement: acknowledgedFinding(group.fingerprint, group.clone) }];
  });
  const presented = presentJscpdChanged(
    candidates.map(({ group }) => group.clone),
    changedPathSet,
    config.maxFindings,
    comparison.ambiguous.length,
  );
  const surfaced = candidates
    .slice(0, presented.findings.length)
    .map(({ acknowledgement }) => acknowledgement);
  if (acknowledgements.reconcile(revision, active, surfaced)) options.stateChanged?.();
  return presented;
}

function reportFromRun(result: JscpdRunResult<JscpdScanReport>): JscpdScanReport | undefined {
  if (result.status === "report") return result.value;
  if (result.status === "no-findings") return result.value;
  return undefined;
}

async function safeBaseline(service: JscpdBaselineService): Promise<JscpdBaselineState> {
  try {
    return await service.wait();
  } catch {
    return { status: "failed", stage: "scan", reason: "internal-error" };
  }
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
