import { Cause, Context, Deferred, Effect, FiberId, Layer, MutableRef } from "effect";
import {
  createJscpdExecutionPath,
  type JscpdCapabilityResult,
  type JscpdCapabilityService,
} from "./capability.js";
import { indexJscpdCloneReportEffect, type JscpdCloneSnapshot } from "./clone-identity.js";
import type { JscpdFileSystem, JscpdProcess } from "./effect/services.js";
import type { JscpdRunFailureReason, JscpdRunResult, JscpdService } from "./jscpd.js";
import { consumeJscpdV5JsonReportEffect } from "./jscpd-report.js";
import { optionalCanonicalDirectoryEffect } from "./path-utils.js";
import {
  adapterRunEffect,
  capabilityProbeEffect,
  createJscpdScanArguments,
  JSCPD_CLONE_POSITIVE_EXIT_CODES,
} from "./scan.js";
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
  startEffect: (
    context: JscpdBaselineStartContext,
  ) => Effect.Effect<JscpdBaselineState, never, JscpdFileSystem | JscpdProcess>;
  /** Await the current capture, if any. */
  readonly waitEffect: Effect.Effect<JscpdBaselineState>;
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
  readonly completion: Deferred.Deferred<JscpdBaselineState>;
}

interface BaselineOwnerState {
  readonly generation: number;
  readonly baseline: JscpdBaselineState;
  readonly active?: ActiveCapture;
}

interface JscpdBaselineEffectService {
  readonly start: (
    context: JscpdBaselineStartContext,
  ) => Effect.Effect<JscpdBaselineState, never, JscpdFileSystem | JscpdProcess>;
  readonly wait: Effect.Effect<JscpdBaselineState>;
  readonly disable: Effect.Effect<void>;
  readonly invalidate: Effect.Effect<void>;
  readonly current: Effect.Effect<JscpdBaselineState>;
}

export const JscpdBaseline = Context.GenericTag<JscpdBaselineEffectService>(
  "pi-jscpd/effect/Baseline",
);

const UNSTARTED: JscpdBaselineState = Object.freeze({ status: "unstarted" });
const PENDING: JscpdBaselineState = Object.freeze({ status: "pending" });

/** Capture one full-project normalized report without exposing it to model context or disk. */
export function createJscpdBaselineService(
  capabilityService: JscpdCapabilityService,
  adapterService: JscpdService,
  options: JscpdBaselineOptions = {},
): JscpdBaselineService {
  return baselineServiceFor(new BaselineOwner(capabilityService, adapterService, options));
}

export function createJscpdBaselineLayer(
  capabilityService: JscpdCapabilityService,
  adapterService: JscpdService,
  options: JscpdBaselineOptions = {},
) {
  return Layer.scoped(
    JscpdBaseline,
    Effect.acquireRelease(
      Effect.sync(() => new BaselineOwner(capabilityService, adapterService, options)),
      (owner) => Effect.sync(() => owner.invalidate()),
    ).pipe(Effect.map(baselineEffectServiceFor)),
  );
}

class BaselineOwner {
  readonly #capability: JscpdCapabilityService;
  readonly #adapter: JscpdService;
  readonly #path: string | undefined;
  readonly #state = MutableRef.make<BaselineOwnerState>({
    generation: 0,
    baseline: UNSTARTED,
  });

  constructor(
    capability: JscpdCapabilityService,
    adapter: JscpdService,
    options: JscpdBaselineOptions,
  ) {
    this.#capability = capability;
    this.#adapter = adapter;
    this.#path = options.path;
  }

  startEffect(
    context: JscpdBaselineStartContext,
  ): Effect.Effect<JscpdBaselineState, never, JscpdFileSystem | JscpdProcess> {
    return Effect.suspend(() => this.startPreparedEffect(context));
  }

  startPreparedEffect(
    context: JscpdBaselineStartContext,
  ): Effect.Effect<JscpdBaselineState, never, JscpdFileSystem | JscpdProcess> {
    const completion = Deferred.unsafeMake<JscpdBaselineState>(FiberId.none);
    const started = this.#beginCapture(context, completion);
    if (!started.active) return Effect.succeed(started.baseline);
    const active = started.active;
    const capture = captureBaselineEffect(
      this.#capability,
      this.#adapter,
      context,
      active.controller,
      this.#path,
    ).pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(failed("scan", "internal-error")),
      ),
      Effect.map((result) => this.#settleCapture(result, active)),
      Effect.tap((result) => Deferred.succeed(completion, result)),
      Effect.onInterrupt(() => Effect.sync(() => this.#interruptCapture(active))),
    );
    return Effect.raceFirst(capture, Deferred.await(completion));
  }

  waitEffect(): Effect.Effect<JscpdBaselineState> {
    const state = MutableRef.get(this.#state);
    return state.active ? Deferred.await(state.active.completion) : Effect.succeed(state.baseline);
  }

  disable(): void {
    this.#replaceState(Object.freeze({ status: "unavailable", reason: "disabled" }));
  }

  invalidate(): void {
    this.#replaceState(UNSTARTED);
  }

  current(): JscpdBaselineState {
    return MutableRef.get(this.#state).baseline;
  }

  #beginCapture(
    context: JscpdBaselineStartContext,
    completion: Deferred.Deferred<JscpdBaselineState>,
  ): BaselineOwnerState {
    const baseline = initialState(context);
    const generation = this.#replaceState(baseline);
    if (baseline.status !== "unstarted") return MutableRef.get(this.#state);
    const active = { generation, controller: new AbortController(), completion };
    const started = { generation, baseline: PENDING, active };
    MutableRef.set(this.#state, started);
    return started;
  }

  #replaceState(baseline: JscpdBaselineState): number {
    const current = MutableRef.get(this.#state);
    cancelActiveCapture(current.active);
    const generation = current.generation + 1;
    MutableRef.set(this.#state, { generation, baseline });
    return generation;
  }

  #interruptCapture(capture: ActiveCapture): void {
    capture.controller.abort();
    const result = this.#settleCapture(lifecycleCancelled(), capture);
    Deferred.unsafeDone(capture.completion, Effect.succeed(result));
  }

  #settleCapture(result: JscpdBaselineState, capture: ActiveCapture): JscpdBaselineState {
    const current = MutableRef.get(this.#state);
    if (current.generation !== capture.generation || current.active !== capture) {
      return lifecycleCancelled();
    }
    MutableRef.set(this.#state, { generation: current.generation, baseline: result });
    return result;
  }
}

function cancelActiveCapture(active: ActiveCapture | undefined): void {
  if (!active) return;
  active.controller.abort();
  Deferred.unsafeDone(active.completion, Effect.succeed(lifecycleCancelled()));
}

function lifecycleCancelled(): JscpdBaselineState {
  return Object.freeze({ status: "cancelled", stage: "lifecycle" });
}

function baselineServiceFor(owner: BaselineOwner): JscpdBaselineService {
  return {
    startEffect: (context) => owner.startEffect(context),
    waitEffect: Effect.suspend(() => owner.waitEffect()),
    disable: () => owner.disable(),
    invalidate: () => owner.invalidate(),
    current: () => owner.current(),
  };
}

function baselineEffectServiceFor(owner: BaselineOwner): JscpdBaselineEffectService {
  return {
    start: (context) => owner.startEffect(context),
    wait: Effect.suspend(() => owner.waitEffect()),
    disable: Effect.sync(() => owner.disable()),
    invalidate: Effect.sync(() => owner.invalidate()),
    current: Effect.sync(() => owner.current()),
  };
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

function captureBaselineEffect(
  capabilityService: JscpdCapabilityService,
  adapterService: JscpdService,
  context: JscpdBaselineStartContext,
  controller: AbortController,
  path: string | undefined,
): Effect.Effect<JscpdBaselineState, never, JscpdFileSystem | JscpdProcess> {
  return Effect.gen(function* () {
    const cwd = yield* optionalCanonicalDirectoryEffect(context.cwd);
    if (!cwd) return failed("project", "invalid-project");

    const capability = yield* safeProbeEffect(capabilityService, { cwd, path }, controller);
    if (capability.status !== "available") return stateFromCapability(capability);

    const result = yield* runBaselineAdapterEffect(
      adapterService,
      capability,
      context,
      cwd,
      path,
      controller,
    );
    return yield* stateFromRunResultEffect(result, cwd);
  });
}

function safeProbeEffect(
  capabilityService: JscpdCapabilityService,
  request: Omit<Parameters<JscpdCapabilityService["probeEffect"]>[0], "signal">,
  controller: AbortController,
): Effect.Effect<JscpdCapabilityResult, never, JscpdProcess> {
  return capabilityProbeEffect(capabilityService, {
    ...request,
    signal: controller.signal,
  });
}

function runBaselineAdapterEffect(
  adapterService: JscpdService,
  capability: Extract<JscpdCapabilityResult, { status: "available" }>,
  context: JscpdBaselineStartContext,
  cwd: string,
  path: string | undefined,
  controller: AbortController,
): Effect.Effect<JscpdRunResult<JscpdScanReport>, never, JscpdFileSystem | JscpdProcess> {
  return adapterRunEffect(adapterService, {
    executable: capability.executable,
    cwd,
    path: createJscpdExecutionPath(cwd, path, capability.source),
    signal: controller.signal,
    timeoutMs: context.timeoutMs,
    reportExitCodes: JSCPD_CLONE_POSITIVE_EXIT_CODES,
    createArguments: ({ directory }) => createJscpdScanArguments(directory, ["."]),
    consumeReportEffect: (bytes) => consumeJscpdV5JsonReportEffect(bytes, cwd),
  });
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

function stateFromRunResultEffect(
  result: JscpdRunResult<JscpdScanReport>,
  cwd: string,
): Effect.Effect<JscpdBaselineState, never, JscpdFileSystem> {
  switch (result.status) {
    case "report":
      return acceptedEffect("findings", result.value, cwd);
    case "no-findings":
      return result.value
        ? acceptedEffect("clean", result.value, cwd)
        : Effect.succeed(failed("scan", "invalid-report"));
    case "no-report":
      return Effect.succeed(failed("scan", "missing-report"));
    case "cancelled":
      return Effect.succeed(Object.freeze({ status: "cancelled", stage: "scan" }));
    case "invalidated":
      return Effect.succeed(lifecycleCancelled());
    case "timed-out":
      return Effect.succeed(
        Object.freeze({ status: "timed-out", stage: "scan", timeoutMs: result.timeoutMs }),
      );
    case "failed":
      return Effect.succeed(failedFromRun(result.reason, result.reportError));
  }
}

function acceptedEffect(
  outcome: "clean" | "findings",
  report: JscpdScanReport,
  cwd: string,
): Effect.Effect<JscpdBaselineState, never, JscpdFileSystem> {
  return indexJscpdCloneReportEffect(report, cwd).pipe(
    Effect.map((snapshot) => Object.freeze({ status: "accepted", outcome, report, snapshot })),
  );
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
