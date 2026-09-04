import { Context, Effect, Layer, MutableRef } from "effect";
import { compareJscpdCloneSnapshots, type JscpdCloneSnapshot } from "./clone-identity.js";
import type { JscpdChangedResult, JscpdCompletedResult, JscpdVerificationResult } from "./types.js";

export type JscpdVerificationKind = "changed" | "project";

export interface JscpdVerificationService {
  compareAndRemember(
    kind: JscpdVerificationKind,
    scopeKey: string,
    snapshot: JscpdCloneSnapshot,
    expectedScope?: number,
  ): JscpdVerificationResult;
  scope(): number;
  reset(): void;
}

interface VerificationCheckpoint {
  readonly scopeKey: string;
  readonly snapshot: JscpdCloneSnapshot;
}

interface VerificationState {
  readonly scope: number;
  readonly checkpoints: ReadonlyMap<JscpdVerificationKind, VerificationCheckpoint>;
}

interface JscpdVerificationEffectService {
  readonly compareAndRemember: (
    kind: JscpdVerificationKind,
    scopeKey: string,
    snapshot: JscpdCloneSnapshot,
    expectedScope?: number,
  ) => Effect.Effect<JscpdVerificationResult>;
  readonly scope: Effect.Effect<number>;
  readonly reset: Effect.Effect<void>;
}

export const JscpdVerification = Context.GenericTag<JscpdVerificationEffectService>(
  "pi-jscpd/effect/Verification",
);

/** Keep one ephemeral pre-refactor checkpoint for each explicit scan kind. */
export function createJscpdVerificationService(): JscpdVerificationService {
  return verificationServiceFor(new VerificationOwner());
}

export function createJscpdVerificationLayer() {
  const owner = new VerificationOwner();
  return Layer.succeed(JscpdVerification, verificationEffectServiceFor(owner));
}

class VerificationOwner {
  readonly #state = MutableRef.make<VerificationState>({ scope: 0, checkpoints: new Map() });

  compareAndRemember(
    kind: JscpdVerificationKind,
    scopeKey: string,
    snapshot: JscpdCloneSnapshot,
    expectedScope = this.scope(),
  ): JscpdVerificationResult {
    const state = MutableRef.get(this.#state);
    if (state.scope !== expectedScope) return staleVerification(kind);
    if (snapshot.status !== "accepted") return unavailableVerification(kind);
    const previous = state.checkpoints.get(kind);
    const checkpoints = new Map(state.checkpoints);
    checkpoints.set(kind, Object.freeze({ scopeKey, snapshot }));
    MutableRef.set(this.#state, { ...state, checkpoints });
    return previous?.scopeKey === scopeKey
      ? compareVerificationSnapshots(kind, previous.snapshot, snapshot)
      : checkpointVerification(kind, snapshot.groups.length);
  }

  scope(): number {
    return MutableRef.get(this.#state).scope;
  }

  reset(): void {
    const state = MutableRef.get(this.#state);
    MutableRef.set(this.#state, { scope: state.scope + 1, checkpoints: new Map() });
  }
}

function compareVerificationSnapshots(
  kind: JscpdVerificationKind,
  previous: JscpdCloneSnapshot,
  snapshot: JscpdCloneSnapshot,
): JscpdVerificationResult {
  const comparison = compareJscpdCloneSnapshots(previous, snapshot);
  return comparedVerification(
    kind,
    comparison.removed.length,
    comparison.existing.length,
    comparison.new.length,
    comparison.ambiguous.length,
  );
}

function verificationServiceFor(owner: VerificationOwner): JscpdVerificationService {
  return {
    compareAndRemember: (kind, scopeKey, snapshot, expectedScope) =>
      owner.compareAndRemember(kind, scopeKey, snapshot, expectedScope),
    scope: () => owner.scope(),
    reset: () => owner.reset(),
  };
}

function verificationEffectServiceFor(owner: VerificationOwner): JscpdVerificationEffectService {
  return {
    compareAndRemember: (kind, scopeKey, snapshot, expectedScope) =>
      Effect.sync(() => owner.compareAndRemember(kind, scopeKey, snapshot, expectedScope)),
    scope: Effect.sync(() => owner.scope()),
    reset: Effect.sync(() => owner.reset()),
  };
}

export function withJscpdVerification(
  result: JscpdCompletedResult,
  verification: JscpdVerificationResult,
): JscpdCompletedResult;
export function withJscpdVerification(
  result: JscpdChangedResult,
  verification: JscpdVerificationResult,
): JscpdChangedResult;
export function withJscpdVerification(
  result: JscpdCompletedResult | JscpdChangedResult,
  verification: JscpdVerificationResult,
): JscpdCompletedResult | JscpdChangedResult {
  return Object.freeze({
    ...result,
    message: `${result.message}\n${verification.message}`,
    terminalMessage: `${result.terminalMessage}\n${verification.message}`,
    verification,
  });
}

function checkpointVerification(
  kind: JscpdVerificationKind,
  groups: number,
): JscpdVerificationResult {
  const route = kind === "changed" ? "/jscpd changed" : "the same /jscpd scan";
  return Object.freeze({
    state: "checkpoint",
    scope: kind,
    groups,
    message: `Verification checkpoint recorded with ${counted(groups, "duplicate block")}. After ordinary edits and relevant tests, rerun ${route} to compare the result.`,
  });
}

function comparedVerification(
  kind: JscpdVerificationKind,
  removed: number,
  remaining: number,
  created: number,
  ambiguous: number,
): JscpdVerificationResult {
  const qualifier = ambiguous > 0 ? ` ${counted(ambiguous, "comparison")} remained ambiguous.` : "";
  return Object.freeze({
    state: "compared",
    scope: kind,
    removed,
    remaining,
    created,
    ambiguous,
    message: `Verification since the previous matching ${kind} scan: ${removed} removed, ${remaining} remaining, ${created} newly created.${qualifier}`,
  });
}

function unavailableVerification(kind: JscpdVerificationKind): JscpdVerificationResult {
  return Object.freeze({
    state: "unavailable",
    scope: kind,
    reason: "identity-partial",
    message:
      "Verification comparison is unavailable because complete content identities could not be derived; the current scan result remains advisory.",
  });
}

function staleVerification(kind: JscpdVerificationKind): JscpdVerificationResult {
  return Object.freeze({
    state: "unavailable",
    scope: kind,
    reason: "lifecycle-changed",
    message:
      "Verification comparison was discarded because the session or branch changed; rerun the explicit check in the current context.",
  });
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
