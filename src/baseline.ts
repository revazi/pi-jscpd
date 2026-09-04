import {
  createJscpdExecutionPath,
  type JscpdCapabilityResult,
  type JscpdCapabilityService,
} from "./capability.js";
import { indexJscpdCloneReport, type JscpdCloneSnapshot } from "./clone-identity.js";
import type { JscpdRunFailureReason, JscpdRunResult, JscpdService } from "./jscpd.js";
import { consumeJscpdV5JsonReport } from "./jscpd-report.js";
import { canonicalDirectory } from "./path-utils.js";
import { createJscpdScanArguments, JSCPD_CLONE_POSITIVE_EXIT_CODES } from "./scan.js";
import type { JscpdReportErrorCode, JscpdScanReport } from "./types.js";

export interface JscpdBaselineStartContext {
  readonly cwd: string;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly hasPriorChanges: boolean;
}

export type JscpdBaselineState =
  | { readonly status: "unstarted" }
  | { readonly status: "pending" }
  | {
      readonly status: "accepted";
      readonly outcome: "clean" | "findings";
      /** Strict normalized report retained in memory only. */
      readonly report: JscpdScanReport;
      /** Content-aware identities captured before source mutation. */
      readonly snapshot: JscpdCloneSnapshot;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "disabled" | "missing-binary" | "incompatible-version";
    }
  | { readonly status: "partial"; readonly reason: "restored-after-changes" }
  | { readonly status: "cancelled"; readonly stage: "probe" | "scan" | "lifecycle" }
  | {
      readonly status: "timed-out";
      readonly stage: "probe" | "scan";
      readonly timeoutMs: number;
    }
  | {
      readonly status: "failed";
      readonly stage: "project" | "probe" | "scan";
      readonly reason: string;
      readonly reportError?: JscpdReportErrorCode;
    };

export interface JscpdBaselineService {
  /** Replace current lifecycle state and schedule at most one capture for this generation. */
  start(context: JscpdBaselineStartContext): Promise<JscpdBaselineState>;
  /** Await the current capture, if any. Never rejects. */
  wait(): Promise<JscpdBaselineState>;
  /** Cancel current work and mark automatic capture disabled. */
  disable(): void;
  /** Cancel current work and clear ephemeral report state. */
  invalidate(): void;
  current(): JscpdBaselineState;
}

export interface JscpdBaselineOptions {
  /** Stable PATH override used by deterministic tests. */
  readonly path?: string;
}

interface ActiveCapture {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<JscpdBaselineState>;
}

const UNSTARTED: JscpdBaselineState = Object.freeze({ status: "unstarted" });
const PENDING: JscpdBaselineState = Object.freeze({ status: "pending" });

/** Capture one full-project normalized report without exposing it to model context or disk. */
export function createJscpdBaselineService(
  capabilityService: JscpdCapabilityService,
  adapterService: JscpdService,
  options: JscpdBaselineOptions = {},
): JscpdBaselineService {
  let generation = 0;
  let state: JscpdBaselineState = UNSTARTED;
  let active: ActiveCapture | undefined;

  const replaceState = (next: JscpdBaselineState): void => {
    generation += 1;
    active?.controller.abort();
    active = undefined;
    state = next;
  };

  return {
    start(context) {
      replaceState(initialState(context));
      if (state.status !== "unstarted") return Promise.resolve(state);

      state = PENDING;
      const captureGeneration = generation;
      const controller = new AbortController();
      const promise = captureBaseline(
        capabilityService,
        adapterService,
        context,
        controller.signal,
        options.path,
      ).then(
        (result) => settleCapture(result, captureGeneration),
        () => settleCapture(failed("scan", "internal-error"), captureGeneration),
      );
      active = { generation: captureGeneration, controller, promise };
      return promise;
    },
    wait() {
      return active?.promise ?? Promise.resolve(state);
    },
    disable() {
      replaceState(Object.freeze({ status: "unavailable", reason: "disabled" }));
    },
    invalidate() {
      replaceState(UNSTARTED);
    },
    current: () => state,
  };

  function settleCapture(
    result: JscpdBaselineState,
    captureGeneration: number,
  ): JscpdBaselineState {
    if (captureGeneration !== generation || active?.generation !== captureGeneration) {
      return Object.freeze({ status: "cancelled", stage: "lifecycle" });
    }
    active = undefined;
    state = result;
    return state;
  }
}

function initialState(context: JscpdBaselineStartContext): JscpdBaselineState {
  if (context.hasPriorChanges) {
    return Object.freeze({ status: "partial", reason: "restored-after-changes" });
  }
  if (!context.enabled) {
    return Object.freeze({ status: "unavailable", reason: "disabled" });
  }
  return UNSTARTED;
}

async function captureBaseline(
  capabilityService: JscpdCapabilityService,
  adapterService: JscpdService,
  context: JscpdBaselineStartContext,
  signal: AbortSignal,
  path: string | undefined,
): Promise<JscpdBaselineState> {
  const cwd = await canonicalDirectory(context.cwd);
  if (!cwd) return failed("project", "invalid-project");

  const capability = await safeProbe(capabilityService, { cwd, path, signal });
  if (capability.status !== "available") return stateFromCapability(capability);

  let result: JscpdRunResult<JscpdScanReport>;
  try {
    result = await adapterService.run<JscpdScanReport>({
      executable: capability.executable,
      cwd,
      path: createJscpdExecutionPath(cwd, path, capability.source),
      signal,
      timeoutMs: context.timeoutMs,
      reportExitCodes: JSCPD_CLONE_POSITIVE_EXIT_CODES,
      createArguments: ({ directory }) => createJscpdScanArguments(directory, ["."]),
      consumeReport: (bytes) => consumeJscpdV5JsonReport(bytes, cwd),
    });
  } catch {
    return failed("scan", "internal-error");
  }
  return stateFromRunResult(result, cwd);
}

async function safeProbe(
  capabilityService: JscpdCapabilityService,
  request: Parameters<JscpdCapabilityService["probe"]>[0],
): Promise<JscpdCapabilityResult> {
  try {
    return await capabilityService.probe(request);
  } catch {
    return { status: "failed", executable: "jscpd", reason: "execution-error" };
  }
}

function stateFromCapability(
  capability: Exclude<JscpdCapabilityResult, { status: "available" }>,
): JscpdBaselineState {
  switch (capability.status) {
    case "missing":
      return Object.freeze({ status: "unavailable", reason: "missing-binary" });
    case "incompatible":
      return Object.freeze({ status: "unavailable", reason: "incompatible-version" });
    case "cancelled":
      return Object.freeze({ status: "cancelled", stage: "probe" });
    case "timed-out":
      return Object.freeze({
        status: "timed-out",
        stage: "probe",
        timeoutMs: capability.timeoutMs,
      });
    case "failed":
      return failed("probe", capability.reason);
  }
}

async function stateFromRunResult(
  result: JscpdRunResult<JscpdScanReport>,
  cwd: string,
): Promise<JscpdBaselineState> {
  switch (result.status) {
    case "report":
      return accepted("findings", result.value, cwd);
    case "no-findings":
      return result.value ? accepted("clean", result.value, cwd) : failed("scan", "invalid-report");
    case "no-report":
      return failed("scan", "missing-report");
    case "cancelled":
      return Object.freeze({ status: "cancelled", stage: "scan" });
    case "invalidated":
      return Object.freeze({ status: "cancelled", stage: "lifecycle" });
    case "timed-out":
      return Object.freeze({ status: "timed-out", stage: "scan", timeoutMs: result.timeoutMs });
    case "failed":
      return failedFromRun(result.reason, result.reportError);
  }
}

async function accepted(
  outcome: "clean" | "findings",
  report: JscpdScanReport,
  cwd: string,
): Promise<JscpdBaselineState> {
  const snapshot = await indexJscpdCloneReport(report, cwd);
  return Object.freeze({ status: "accepted", outcome, report, snapshot });
}

function failedFromRun(
  reason: JscpdRunFailureReason,
  reportError: JscpdReportErrorCode | undefined,
): JscpdBaselineState {
  return reportError
    ? Object.freeze({ status: "failed", stage: "scan", reason, reportError })
    : failed("scan", reason);
}

function failed(
  stage: Extract<JscpdBaselineState, { status: "failed" }>["stage"],
  reason: string,
): JscpdBaselineState {
  return Object.freeze({ status: "failed", stage, reason });
}
