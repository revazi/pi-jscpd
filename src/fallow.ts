import { join } from "node:path";
import { Context, Effect, Layer, MutableRef } from "effect";
import { JscpdFileSystem } from "./effect/services.js";
import { canonicalDirectoryEffect, isPathInside } from "./path-utils.js";

const MAX_SIGNAL_FILE_BYTES = 64 * 1024;
const CONFIG_FILES = [".fallowrc", ".fallowrc.json", ".fallowrc.jsonc", "fallow.toml"] as const;
const FALLOW_DEPENDENCIES = new Set(["fallow", "pi-fallow"]);

export type JscpdFallowCoexistencePolicy = "auto" | "on-demand" | "allow";
export type JscpdFallowOverlapSignal =
  | "active-pi-fallow-tool"
  | "duplication-config-enabled"
  | "duplication-config-disabled"
  | "duplication-script"
  | "fallow-config-present"
  | "fallow-dependency"
  | "unreadable-signal";

export interface JscpdFallowCoexistenceState {
  readonly status: "absent" | "detected" | "ambiguous" | "explicit-allow" | "explicit-on-demand";
  readonly policy: JscpdFallowCoexistencePolicy;
  readonly automaticAllowed: boolean;
  readonly signals: readonly JscpdFallowOverlapSignal[];
  readonly statusText: string;
  readonly notice?: string;
}

export interface JscpdFallowCoexistenceContext {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly policy?: JscpdFallowCoexistencePolicy;
  readonly fallowToolAvailable: boolean;
}

export interface JscpdFallowCoexistenceService {
  evaluateEffect: (
    context: JscpdFallowCoexistenceContext,
  ) => Effect.Effect<JscpdFallowCoexistenceState, never, JscpdFileSystem>;
  current(): JscpdFallowCoexistenceState;
  automaticAllowed(): boolean;
  takeNotice(): string | undefined;
  reset(): void;
}

interface JscpdFallowWorkflowService {
  readonly evaluate: (
    context: JscpdFallowCoexistenceContext,
  ) => Effect.Effect<JscpdFallowCoexistenceState, never, JscpdFileSystem>;
  readonly current: Effect.Effect<JscpdFallowCoexistenceState>;
  readonly takeNotice: Effect.Effect<string | undefined>;
  readonly reset: Effect.Effect<void>;
}

export const JscpdFallowWorkflow = Context.GenericTag<JscpdFallowWorkflowService>(
  "pi-jscpd/effect/FallowWorkflow",
);

interface ProjectSignals {
  readonly duplicationConfig?: "enabled" | "disabled";
  readonly script: boolean;
  readonly configPresent: boolean;
  readonly dependency: boolean;
  readonly unreadable: boolean;
}

export function createJscpdFallowCoexistenceService(): JscpdFallowCoexistenceService {
  const owner = new FallowWorkflowOwner();
  return {
    evaluateEffect: (context) => owner.evaluateEffect(context),
    current: () => owner.current(),
    automaticAllowed: () => owner.current().automaticAllowed,
    takeNotice: () => owner.takeNotice(),
    reset: () => owner.reset(),
  };
}

export function createJscpdFallowCoexistenceLayer() {
  const owner = new FallowWorkflowOwner();
  return Layer.succeed(JscpdFallowWorkflow, {
    evaluate: (context) => owner.evaluateEffect(context),
    current: Effect.sync(() => owner.current()),
    takeNotice: Effect.sync(() => owner.takeNotice()),
    reset: Effect.sync(() => owner.reset()),
  });
}

interface FallowOwnerState {
  readonly generation: number;
  readonly value: JscpdFallowCoexistenceState;
  readonly noticeDelivered: boolean;
}

class FallowWorkflowOwner {
  readonly #state = MutableRef.make<FallowOwnerState>({
    generation: 0,
    value: absentState(),
    noticeDelivered: false,
  });

  evaluateEffect(
    context: JscpdFallowCoexistenceContext,
  ): Effect.Effect<JscpdFallowCoexistenceState, never, JscpdFileSystem> {
    return Effect.suspend(() => {
      const generation = this.#beginEvaluation();
      return evaluateJscpdFallowCoexistenceEffect(context).pipe(
        Effect.map((value) => this.#commitEvaluation(generation, value)),
      );
    });
  }

  current(): JscpdFallowCoexistenceState {
    return MutableRef.get(this.#state).value;
  }

  takeNotice(): string | undefined {
    const current = MutableRef.get(this.#state);
    if (current.noticeDelivered || !current.value.notice) return undefined;
    MutableRef.set(this.#state, { ...current, noticeDelivered: true });
    return current.value.notice;
  }

  reset(): void {
    const current = MutableRef.get(this.#state);
    MutableRef.set(this.#state, {
      generation: current.generation + 1,
      value: absentState(),
      noticeDelivered: false,
    });
  }

  #beginEvaluation(): number {
    const current = MutableRef.get(this.#state);
    const generation = current.generation + 1;
    MutableRef.set(this.#state, { ...current, generation });
    return generation;
  }

  #commitEvaluation(
    generation: number,
    value: JscpdFallowCoexistenceState,
  ): JscpdFallowCoexistenceState {
    const current = MutableRef.get(this.#state);
    if (current.generation !== generation) return current.value;
    MutableRef.set(this.#state, { ...current, value });
    return value;
  }
}

export function evaluateJscpdFallowCoexistenceEffect(
  context: JscpdFallowCoexistenceContext,
): Effect.Effect<JscpdFallowCoexistenceState, never, JscpdFileSystem> {
  const policy = context.policy ?? "auto";
  if (policy === "on-demand") return Effect.succeed(explicitOnDemandState());
  if (policy === "allow") return Effect.succeed(explicitAllowState());

  return Effect.gen(function* () {
    const project = context.trusted
      ? yield* canonicalDirectoryEffect(context.cwd).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
      : undefined;
    const projectSignals = project
      ? yield* inspectProjectSignalsEffect(project)
      : context.trusted
        ? unreadableProjectSignals()
        : emptyProjectSignals();
    return coexistenceStateFromSignals(
      projectSignals,
      context.fallowToolAvailable,
      context.trusted,
      policy,
    );
  });
}

function coexistenceStateFromSignals(
  projectSignals: ProjectSignals,
  fallowToolAvailable: boolean,
  trusted: boolean,
  policy: JscpdFallowCoexistencePolicy,
): JscpdFallowCoexistenceState {
  const signals = collectSignals(projectSignals, fallowToolAvailable);
  if (projectSignals.duplicationConfig === "disabled") {
    return frozenState({
      status: "absent",
      policy,
      automaticAllowed: true,
      signals,
      statusText: "Fallow overlap: duplication explicitly disabled in Fallow configuration",
    });
  }
  if (projectSignals.unreadable) return ambiguousState(policy, signals);
  if (hasActiveDuplication(projectSignals, fallowToolAvailable)) return detectedState(signals);
  if (hasAmbiguousPresence(projectSignals, fallowToolAvailable, trusted)) {
    return ambiguousState(policy, signals);
  }
  return absentState(signals);
}

function hasActiveDuplication(project: ProjectSignals, fallowToolAvailable: boolean): boolean {
  return (
    project.duplicationConfig === "enabled" ||
    project.script ||
    (fallowToolAvailable && (project.configPresent || project.dependency))
  );
}

function hasAmbiguousPresence(
  project: ProjectSignals,
  fallowToolAvailable: boolean,
  trusted: boolean,
): boolean {
  return !trusted || fallowToolAvailable || project.configPresent || project.dependency;
}

function ambiguousState(
  policy: JscpdFallowCoexistencePolicy,
  signals: readonly JscpdFallowOverlapSignal[],
): JscpdFallowCoexistenceState {
  return frozenState({
    status: "ambiguous",
    policy,
    automaticAllowed: true,
    signals,
    statusText: "Fallow overlap: ambiguous; automatic jscpd checks remain enabled",
  });
}

function inspectProjectSignalsEffect(
  project: string,
): Effect.Effect<ProjectSignals, never, JscpdFileSystem> {
  return Effect.all([inspectFallowConfigEffect(project), inspectPackageJsonEffect(project)], {
    concurrency: "unbounded",
  }).pipe(
    Effect.map(([config, packageSignals]) =>
      Object.freeze({
        duplicationConfig: config.duplicationConfig,
        script: packageSignals.script,
        configPresent: config.present,
        dependency: packageSignals.dependency,
        unreadable: config.unreadable || packageSignals.unreadable,
      }),
    ),
  );
}

function inspectFallowConfigEffect(project: string) {
  return Effect.gen(function* () {
    for (const name of CONFIG_FILES) {
      const file = yield* readBoundedProjectFileEffect(project, name);
      if (file.status === "missing") continue;
      if (file.status !== "bytes") return { present: true, unreadable: true };
      if (name === ".fallowrc.jsonc" || name === "fallow.toml") {
        return { present: true, unreadable: true };
      }
      return inspectJsonFallowConfig(file.value);
    }
    return { present: false, unreadable: false };
  });
}

function inspectJsonFallowConfig(bytes: Uint8Array): {
  duplicationConfig?: "enabled" | "disabled";
  present: boolean;
  unreadable: boolean;
} {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value)) return { present: true, unreadable: true };
    const duplicates = value.duplicates;
    if (!isRecord(duplicates)) return { present: true, unreadable: false };
    if (duplicates.enabled === false) {
      return { duplicationConfig: "disabled", present: true, unreadable: false };
    }
    if (duplicates.enabled === undefined || duplicates.enabled === true) {
      return { duplicationConfig: "enabled", present: true, unreadable: false };
    }
    return { present: true, unreadable: true };
  } catch {
    return { present: true, unreadable: true };
  }
}

function inspectPackageJsonEffect(project: string) {
  return Effect.map(readBoundedProjectFileEffect(project, "package.json"), (file) => {
    if (file.status === "missing") return emptyPackageSignals();
    if (file.status !== "bytes") return unreadablePackageSignals();
    return inspectPackageJsonBytes(file.value);
  });
}

function inspectPackageJsonBytes(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value)) return unreadablePackageSignals();
    return {
      script: hasDuplicationScript(value.scripts),
      dependency: hasFallowDependency(value),
      unreadable: false,
    };
  } catch {
    return unreadablePackageSignals();
  }
}

function emptyPackageSignals() {
  return { script: false, dependency: false, unreadable: false };
}

function unreadablePackageSignals() {
  return { script: false, dependency: false, unreadable: true };
}

function hasDuplicationScript(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).some(
    (script) => typeof script === "string" && scriptSegments(script).some(isDuplicationCommand),
  );
}

function scriptSegments(script: string): string[] {
  return script.split(/&&|\|\||;/u).map((segment) => segment.trim());
}

function isDuplicationCommand(segment: string): boolean {
  const command = segment.match(
    /^(?:(?:npx(?:\s+--yes)?|npm\s+exec(?:\s+--yes)?(?:\s+--)?)\s+)?fallow(?:\s+(.*))?$/u,
  );
  if (!command) return false;
  const argument = command[1]?.trim().split(/\s+/u)[0];
  return !argument || argument.startsWith("-") || isDuplicationSubcommand(argument);
}

function isDuplicationSubcommand(command: string): boolean {
  return ["dupes", "audit", "all", "check-changed", "review"].includes(command);
}

function hasFallowDependency(manifest: Record<string, unknown>): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
    const dependencies = manifest[field];
    return (
      isRecord(dependencies) &&
      Object.keys(dependencies).some((name) => FALLOW_DEPENDENCIES.has(name))
    );
  });
}

type BoundedFile =
  | { status: "missing" }
  | { status: "bytes"; value: Uint8Array }
  | { status: "unsafe" | "failed" | "too-large" };

function readBoundedProjectFileEffect(
  project: string,
  relativePath: string,
): Effect.Effect<BoundedFile, never, JscpdFileSystem> {
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    filesystem.canonicalize(join(project, relativePath)).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed<BoundedFile>(
            error.reason === "missing" ? { status: "missing" } : { status: "failed" },
          ),
        onSuccess: (canonical) => {
          if (!isPathInside(project, canonical)) {
            return Effect.succeed<BoundedFile>({ status: "unsafe" });
          }
          return filesystem
            .read({
              path: canonical,
              maxBytes: MAX_SIGNAL_FILE_BYTES,
              regularFileOnly: true,
              noFollow: true,
              limitSubject: "configuration",
            })
            .pipe(
              Effect.match({
                onFailure: (error): BoundedFile =>
                  error._tag === "JscpdLimitExceeded"
                    ? { status: "too-large" }
                    : { status: "failed" },
                onSuccess: (value): BoundedFile => ({ status: "bytes", value }),
              }),
            );
        },
      }),
    ),
  );
}

function collectSignals(
  project: ProjectSignals,
  fallowToolAvailable: boolean,
): readonly JscpdFallowOverlapSignal[] {
  const signals: JscpdFallowOverlapSignal[] = [];
  if (fallowToolAvailable) signals.push("active-pi-fallow-tool");
  if (project.duplicationConfig === "enabled") signals.push("duplication-config-enabled");
  if (project.duplicationConfig === "disabled") signals.push("duplication-config-disabled");
  if (project.script) signals.push("duplication-script");
  if (project.configPresent && !project.duplicationConfig) signals.push("fallow-config-present");
  if (project.dependency) signals.push("fallow-dependency");
  if (project.unreadable) signals.push("unreadable-signal");
  return Object.freeze(signals);
}

function detectedState(signals: readonly JscpdFallowOverlapSignal[]): JscpdFallowCoexistenceState {
  return frozenState({
    status: "detected",
    policy: "auto",
    automaticAllowed: false,
    signals,
    statusText: "Fallow overlap: detected; automatic jscpd checks are on demand",
    notice:
      "Fallow duplication analysis appears active. To avoid duplicate warnings, automatic jscpd changed checks are on demand; no configuration was changed. Use /jscpd changed or a scoped /jscpd scan <target>. Set fallowCoexistence to ‘allow’ for both automatic analyzers or ‘on-demand’ to make the choice explicit.",
  });
}

function explicitOnDemandState(): JscpdFallowCoexistenceState {
  return frozenState({
    status: "explicit-on-demand",
    policy: "on-demand",
    automaticAllowed: false,
    signals: [],
    statusText: "Fallow coexistence: jscpd automatic checks explicitly on demand",
  });
}

function explicitAllowState(): JscpdFallowCoexistenceState {
  return frozenState({
    status: "explicit-allow",
    policy: "allow",
    automaticAllowed: true,
    signals: [],
    statusText: "Fallow coexistence: both automatic analyzers explicitly allowed",
  });
}

function absentState(
  signals: readonly JscpdFallowOverlapSignal[] = [],
): JscpdFallowCoexistenceState {
  return frozenState({
    status: "absent",
    policy: "auto",
    automaticAllowed: true,
    signals,
    statusText: "Fallow overlap: not detected",
  });
}

function emptyProjectSignals(): ProjectSignals {
  return Object.freeze({
    script: false,
    configPresent: false,
    dependency: false,
    unreadable: false,
  });
}

function unreadableProjectSignals(): ProjectSignals {
  return Object.freeze({
    script: false,
    configPresent: false,
    dependency: false,
    unreadable: true,
  });
}

function frozenState(
  state: Omit<JscpdFallowCoexistenceState, "signals"> & {
    signals: readonly JscpdFallowOverlapSignal[];
  },
): JscpdFallowCoexistenceState {
  return Object.freeze({ ...state, signals: Object.freeze([...state.signals]) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
