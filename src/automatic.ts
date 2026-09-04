import { Cause, Context, Effect, Layer, MutableRef } from "effect";
import type { JscpdAcknowledgedFinding, JscpdAcknowledgementTracker } from "./acknowledgements.js";
import {
  runEffectPromiseAtApplicationBoundary,
  runEffectSyncAtApplicationBoundary,
} from "./effect/runtime-boundary.js";
import { JscpdPiPort } from "./effect/services.js";
import type { JscpdAutomaticScanDisposition } from "./scheduler.js";
import type { JscpdCommandExecutor, JscpdExecutionResult } from "./types.js";

export const JSCPD_AUTOMATIC_MESSAGE_TYPE = "pi-jscpd/automatic-findings";
export const JSCPD_AUTOMATIC_STATUS_KEY = "pi-jscpd";
const MAX_AUTOMATIC_FINDINGS = 5;

export function boundedJscpdAutomaticFindingLimit(configuredLimit: number): number {
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) return MAX_AUTOMATIC_FINDINGS;
  return Math.min(configuredLimit, MAX_AUTOMATIC_FINDINGS);
}

export interface JscpdAutomaticCheckContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Reject result side effects after a mutation or lifecycle transition supersedes this run. */
  readonly isCurrent?: () => boolean;
  readonly onResult?: JscpdAutomaticResultHandler;
}

export type JscpdAutomaticResultHandler = (
  result: JscpdExecutionResult,
  context: JscpdAutomaticCheckContext,
) => JscpdAutomaticScanDisposition | undefined | Promise<JscpdAutomaticScanDisposition | undefined>;

export interface JscpdAutomaticCheck {
  run(context: JscpdAutomaticCheckContext): Promise<JscpdAutomaticScanDisposition>;
  /** Temporary direct Effect path used by the migrated scheduler before M7.7. */
  readonly runEffect?: (
    context: JscpdAutomaticCheckEffectContext<never, unknown>,
  ) => Effect.Effect<JscpdAutomaticScanDisposition>;
}

export interface JscpdAutomaticCheckOptions {
  /** Internal result sink used when a run does not supply its lifecycle-bound sink. */
  readonly onResult?: JscpdAutomaticResultHandler;
  readonly beforeRun?: () => void;
}

export interface JscpdAutomaticCheckEffectScope {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly isCurrent?: () => boolean;
}

export interface JscpdAutomaticCheckEffectContext<R = never, E = never>
  extends JscpdAutomaticCheckEffectScope {
  readonly onResult?: JscpdAutomaticResultEffectHandler<R, E>;
}

export type JscpdAutomaticResultEffectHandler<R = never, E = never> = (
  result: JscpdExecutionResult,
  context: JscpdAutomaticCheckEffectScope,
) => Effect.Effect<JscpdAutomaticScanDisposition | undefined, E, R>;

interface JscpdAutomaticCheckEffectService {
  readonly run: <R, E>(
    context: JscpdAutomaticCheckEffectContext<R, E>,
  ) => Effect.Effect<JscpdAutomaticScanDisposition, never, R>;
}

export const JscpdAutomaticChecking = Context.GenericTag<JscpdAutomaticCheckEffectService>(
  "pi-jscpd/effect/AutomaticChecking",
);

export interface JscpdAutomaticFindingDetails {
  readonly source: "automatic";
  readonly findings: number;
  readonly omittedFindings: number;
  readonly ambiguousFindings: number;
}

export interface JscpdAutomaticResultActions {
  readonly isCurrent: () => boolean;
  readonly isIdle: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly acknowledgements: JscpdAutomaticAcknowledgementTransaction;
  readonly sendFinding: (content: string, details: JscpdAutomaticFindingDetails) => void;
  readonly record: (result: JscpdExecutionResult) => void;
  readonly persist: () => void;
  readonly setStatus?: (text: string) => void;
}

export interface JscpdAutomaticResultEffectActions<R = never> {
  readonly isCurrent: Effect.Effect<boolean, never, R>;
  readonly isIdle: Effect.Effect<boolean, never, R>;
  readonly hasPendingMessages: Effect.Effect<boolean, never, R>;
  readonly acknowledgements: JscpdAutomaticAcknowledgementEffectTransaction;
  readonly sendFinding: (
    content: string,
    details: JscpdAutomaticFindingDetails,
  ) => Effect.Effect<void, unknown, R>;
  readonly record: (result: JscpdExecutionResult) => Effect.Effect<void, unknown, R>;
  readonly persist: Effect.Effect<void, unknown, R>;
  readonly setStatus?: (text: string) => Effect.Effect<void, unknown, R>;
}

export interface JscpdAutomaticPiResultActions<R = never>
  extends Omit<JscpdAutomaticResultEffectActions<R>, "sendFinding" | "setStatus"> {
  readonly hasUI: boolean;
}

export interface JscpdAutomaticAcknowledgementTransaction {
  readonly tracker: JscpdAcknowledgementTracker;
  readonly effects: JscpdAutomaticAcknowledgementEffectTransaction;
  discard(): void;
  ready(): boolean;
  commit(): boolean;
}

export interface JscpdAutomaticAcknowledgementEffectTransaction {
  readonly discard: Effect.Effect<void>;
  readonly ready: Effect.Effect<boolean>;
  readonly commit: Effect.Effect<boolean>;
}

interface StagedAcknowledgements {
  readonly expectedRevision: number;
  readonly active: readonly JscpdAcknowledgedFinding[];
  readonly surfaced: readonly JscpdAcknowledgedFinding[];
}

/** Stage automatic acknowledgement changes until finding delivery succeeds. */
export function createJscpdAutomaticAcknowledgementTransaction(
  source: JscpdAcknowledgementTracker,
): JscpdAutomaticAcknowledgementTransaction {
  const staged = MutableRef.make<StagedAcknowledgements | undefined>(undefined);
  const tracker: JscpdAcknowledgementTracker = {
    restore: () => undefined,
    reset: () => undefined,
    scope: () => source.scope(),
    revision: () => source.revision(),
    findings: () => source.findings(),
    has: (fingerprint) => source.has(fingerprint),
    invalidatePaths: () => false,
    reconcile(expectedRevision, active, surfaced) {
      MutableRef.set(
        staged,
        Object.freeze({
          expectedRevision,
          active: Object.freeze([...active]),
          surfaced: Object.freeze([...surfaced]),
        }),
      );
      return false;
    },
  };
  const discard = () => MutableRef.set(staged, undefined);
  const ready = () => {
    const pending = MutableRef.get(staged);
    return !!pending && source.revision() === pending.expectedRevision;
  };
  const commit = () => {
    const pending = MutableRef.getAndSet(staged, undefined);
    return pending
      ? source.reconcile(pending.expectedRevision, pending.active, pending.surfaced)
      : false;
  };
  const effects = Object.freeze({
    discard: Effect.sync(discard),
    ready: Effect.sync(ready),
    commit: Effect.sync(commit),
  });
  return Object.freeze({ tracker: Object.freeze(tracker), effects, discard, ready, commit });
}

/** Deliver only current actionable findings; clean and failed checks remain outside model context. */
export function handleJscpdAutomaticResult(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticResultActions,
): JscpdAutomaticScanDisposition {
  return runEffectSyncAtApplicationBoundary(
    handleJscpdAutomaticResultEffect(result, createJscpdAutomaticResultEffectActions(actions)),
  );
}

export function handleJscpdAutomaticResultEffect<R>(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticResultEffectActions<R>,
): Effect.Effect<JscpdAutomaticScanDisposition, never, R> {
  return Effect.gen(function* () {
    if (!(yield* automaticDeliveryEligibleEffect(result, actions))) return "deferred";

    if (isActionableChangedResult(result)) {
      const delivered = yield* completeAdvisoryEffect(
        actions.sendFinding(result.message, automaticFindingDetails(result)),
      );
      if (!delivered) return "deferred";
      yield* actions.acknowledgements.commit;
    } else if (isScannedChangedResult(result)) {
      yield* actions.acknowledgements.commit;
    } else {
      yield* actions.acknowledgements.discard;
    }

    yield* ignoreAdvisoryFailure(actions.record(result).pipe(Effect.zipRight(actions.persist)));
    const status = compactJscpdAutomaticStatus(result);
    if (status && actions.setStatus) {
      yield* ignoreAdvisoryFailure(actions.setStatus(status));
    }
    return "attempted";
  });
}

function automaticDeliveryEligibleEffect<R>(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticResultEffectActions<R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    if (!(yield* actions.isCurrent)) return false;
    if (!(yield* actions.isIdle)) return false;
    if (yield* actions.hasPendingMessages) return false;
    return !isScannedChangedResult(result) || (yield* actions.acknowledgements.ready);
  });
}

/** Effect-native Pi delivery keeps the durable message quiet and acknowledges only after success. */
export function handleJscpdAutomaticPiResultEffect<R>(
  result: JscpdExecutionResult,
  actions: JscpdAutomaticPiResultActions<R>,
): Effect.Effect<JscpdAutomaticScanDisposition, never, R | JscpdPiPort> {
  return Effect.flatMap(JscpdPiPort, (pi) =>
    handleJscpdAutomaticResultEffect(result, {
      ...actions,
      sendFinding: (content, details) =>
        pi.sendMessage(
          {
            customType: JSCPD_AUTOMATIC_MESSAGE_TYPE,
            content,
            display: actions.hasUI,
            details,
          },
          false,
        ),
      setStatus: actions.hasUI
        ? (text) => pi.setStatus(JSCPD_AUTOMATIC_STATUS_KEY, text)
        : undefined,
    }),
  );
}

export function compactJscpdAutomaticStatus(result: JscpdExecutionResult): string | undefined {
  if (result.status === "changed") {
    if (!result.scanPerformed) return undefined;
    const count = result.findings.length + result.omittedFindings;
    return result.outcome === "clean"
      ? "jscpd: clean"
      : `jscpd: ${count} new duplicate block${count === 1 ? "" : "s"}`;
  }
  if (result.status === "changed-unavailable") return "jscpd: check unavailable";
  if (result.status === "unavailable") {
    return result.reason === "disabled" ? "jscpd: disabled" : "jscpd: check unavailable";
  }
  if (result.status === "failed") {
    return result.reason === "scan-timed-out" ? "jscpd: check timed out" : "jscpd: check failed";
  }
  return undefined;
}

/** Execute one fail-open changed check without directly injecting anything into Pi context. */
export function createJscpdAutomaticCheck(
  executor: JscpdCommandExecutor,
  options: JscpdAutomaticCheckOptions = {},
): JscpdAutomaticCheck {
  const service = createAutomaticCheckEffectService(executor, automaticEffectOptions(options));
  return {
    run: (context) =>
      runEffectPromiseAtApplicationBoundary(service.run(automaticEffectContext(context))),
    runEffect: (context) => service.run(context),
  };
}

export function createJscpdAutomaticCheckLayer(
  executor: JscpdCommandExecutor,
  options: JscpdAutomaticCheckOptions = {},
) {
  return Layer.succeed(
    JscpdAutomaticChecking,
    createAutomaticCheckEffectService(executor, automaticEffectOptions(options)),
  );
}

interface AutomaticCheckEffectOptions {
  readonly onResult?: JscpdAutomaticResultEffectHandler<never, unknown>;
  readonly beforeRun?: Effect.Effect<void>;
}

function createAutomaticCheckEffectService(
  executor: JscpdCommandExecutor,
  options: AutomaticCheckEffectOptions,
): JscpdAutomaticCheckEffectService {
  return {
    run: (context) =>
      Effect.gen(function* () {
        if (options.beforeRun) yield* options.beforeRun;
        const result = yield* executeAutomaticChangedEffect(executor, context);
        const disposition = automaticDisposition(result, context);
        if (disposition === "deferred") return disposition;
        const handler = context.onResult ?? options.onResult;
        if (handler) {
          const handled = yield* completeAutomaticResultHandler(handler(result, context));
          if (handled === "deferred") return "deferred";
        }
        return isCurrent(context) ? "attempted" : "deferred";
      }),
  };
}

function executeAutomaticChangedEffect<R, E>(
  executor: JscpdCommandExecutor,
  context: JscpdAutomaticCheckEffectContext<R, E>,
): Effect.Effect<JscpdExecutionResult> {
  if (executor.executeEffect) {
    return executor.executeEffect(
      { command: "changed", args: [] },
      { cwd: context.cwd, signal: context.signal },
    );
  }
  return Effect.tryPromise({
    try: () =>
      executor.execute(
        { command: "changed", args: [] },
        { cwd: context.cwd, signal: context.signal },
      ),
    catch: () => automaticFailure(),
  }).pipe(Effect.catchAll((result) => Effect.succeed(result)));
}

function completeAutomaticResultHandler<R, E>(
  effect: Effect.Effect<JscpdAutomaticScanDisposition | undefined, E, R>,
): Effect.Effect<JscpdAutomaticScanDisposition | undefined, never, R> {
  return effect.pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.interrupt : Effect.succeed("deferred" as const),
    ),
  );
}

function automaticEffectOptions(options: JscpdAutomaticCheckOptions): AutomaticCheckEffectOptions {
  return {
    beforeRun: options.beforeRun ? Effect.sync(options.beforeRun) : undefined,
    onResult: options.onResult
      ? (result, context) =>
          Effect.tryPromise({
            try: () => Promise.resolve(options.onResult?.(result, promiseCheckContext(context))),
            catch: (error) => error,
          })
      : undefined,
  };
}

function automaticEffectContext(
  context: JscpdAutomaticCheckContext,
): JscpdAutomaticCheckEffectContext<never, unknown> {
  return {
    cwd: context.cwd,
    signal: context.signal,
    isCurrent: context.isCurrent,
    onResult: context.onResult
      ? (result) =>
          Effect.tryPromise({
            try: () => Promise.resolve(context.onResult?.(result, context)),
            catch: (error) => error,
          })
      : undefined,
  };
}

function promiseCheckContext(context: JscpdAutomaticCheckEffectScope): JscpdAutomaticCheckContext {
  return {
    cwd: context.cwd,
    signal: context.signal,
    isCurrent: context.isCurrent,
  };
}

export function createJscpdAutomaticResultEffectActions(
  actions: JscpdAutomaticResultActions,
): JscpdAutomaticResultEffectActions {
  return {
    isCurrent: Effect.sync(actions.isCurrent),
    isIdle: Effect.sync(actions.isIdle),
    hasPendingMessages: Effect.sync(actions.hasPendingMessages),
    acknowledgements: actions.acknowledgements.effects,
    sendFinding: (content, details) => Effect.sync(() => actions.sendFinding(content, details)),
    record: (result) => Effect.sync(() => actions.record(result)),
    persist: Effect.sync(actions.persist),
    setStatus: actions.setStatus
      ? (text) => Effect.sync(() => actions.setStatus?.(text))
      : undefined,
  };
}

function automaticFindingDetails(
  result: Extract<JscpdExecutionResult, { status: "changed" }>,
): JscpdAutomaticFindingDetails {
  return Object.freeze({
    source: "automatic",
    findings: result.findings.length,
    omittedFindings: result.omittedFindings,
    ambiguousFindings: result.ambiguousFindings,
  });
}

function completeAdvisoryEffect<R>(
  effect: Effect.Effect<void, unknown, R>,
): Effect.Effect<boolean, never, R> {
  return effect.pipe(
    Effect.as(true),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.interrupt : Effect.succeed(false),
    ),
  );
}

function ignoreAdvisoryFailure<R>(
  effect: Effect.Effect<void, unknown, R>,
): Effect.Effect<void, never, R> {
  return effect.pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.interrupt : Effect.void,
    ),
  );
}

function isScannedChangedResult(
  result: JscpdExecutionResult,
): result is Extract<JscpdExecutionResult, { status: "changed" }> {
  return result.status === "changed" && result.scanPerformed;
}

function isActionableChangedResult(
  result: JscpdExecutionResult,
): result is Extract<JscpdExecutionResult, { status: "changed" }> {
  return result.status === "changed" && result.outcome === "findings" && result.findings.length > 0;
}

function automaticDisposition(
  result: JscpdExecutionResult,
  context: Pick<JscpdAutomaticCheckEffectContext<unknown, unknown>, "signal" | "isCurrent">,
): JscpdAutomaticScanDisposition {
  if (!isCurrent(context)) return "deferred";
  if (result.status === "changed-unavailable" && result.reason === "baseline-pending") {
    return "deferred";
  }
  if (result.status === "failed" && result.reason === "scan-cancelled") return "deferred";
  if (result.status === "unavailable" && result.reason === "probe-cancelled") return "deferred";
  return "attempted";
}

function isCurrent(
  context: Pick<JscpdAutomaticCheckEffectContext<unknown, unknown>, "signal" | "isCurrent">,
): boolean {
  return !context.signal.aborted && (context.isCurrent?.() ?? true);
}

function automaticFailure(): JscpdExecutionResult {
  return Object.freeze({
    status: "failed",
    reason: "process-failed",
    message: "The automatic jscpd check failed safely; no result was used.",
  });
}
