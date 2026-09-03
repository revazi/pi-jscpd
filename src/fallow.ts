import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDirectory, isPathInside } from "./path-utils.js";

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
  evaluate(context: JscpdFallowCoexistenceContext): Promise<JscpdFallowCoexistenceState>;
  current(): JscpdFallowCoexistenceState;
  automaticAllowed(): boolean;
  takeNotice(): string | undefined;
  reset(): void;
}

interface ProjectSignals {
  readonly duplicationConfig?: "enabled" | "disabled";
  readonly script: boolean;
  readonly configPresent: boolean;
  readonly dependency: boolean;
  readonly unreadable: boolean;
}

export function createJscpdFallowCoexistenceService(): JscpdFallowCoexistenceService {
  let state = absentState();
  let noticeDelivered = false;
  return {
    async evaluate(context) {
      state = await evaluateJscpdFallowCoexistence(context);
      return state;
    },
    current: () => state,
    automaticAllowed: () => state.automaticAllowed,
    takeNotice() {
      if (noticeDelivered || !state.notice) return undefined;
      noticeDelivered = true;
      return state.notice;
    },
    reset() {
      state = absentState();
      noticeDelivered = false;
    },
  };
}

export async function evaluateJscpdFallowCoexistence(
  context: JscpdFallowCoexistenceContext,
): Promise<JscpdFallowCoexistenceState> {
  const policy = context.policy ?? "auto";
  if (policy === "on-demand") return explicitOnDemandState();
  if (policy === "allow") return explicitAllowState();

  const project = context.trusted ? await canonicalDirectory(context.cwd) : undefined;
  const projectSignals = project
    ? await inspectProjectSignals(project)
    : context.trusted
      ? unreadableProjectSignals()
      : emptyProjectSignals();
  const signals = collectSignals(projectSignals, context.fallowToolAvailable);

  if (projectSignals.duplicationConfig === "disabled") {
    return frozenState({
      status: "absent",
      policy,
      automaticAllowed: true,
      signals,
      statusText: "Fallow overlap: duplication explicitly disabled in Fallow configuration",
    });
  }
  if (projectSignals.unreadable) {
    return frozenState({
      status: "ambiguous",
      policy,
      automaticAllowed: true,
      signals,
      statusText: "Fallow overlap: ambiguous; automatic jscpd checks remain enabled",
    });
  }
  if (
    projectSignals.duplicationConfig === "enabled" ||
    projectSignals.script ||
    (context.fallowToolAvailable && (projectSignals.configPresent || projectSignals.dependency))
  ) {
    return detectedState(signals);
  }
  if (
    !context.trusted ||
    context.fallowToolAvailable ||
    projectSignals.configPresent ||
    projectSignals.dependency
  ) {
    return frozenState({
      status: "ambiguous",
      policy,
      automaticAllowed: true,
      signals,
      statusText: "Fallow overlap: ambiguous; automatic jscpd checks remain enabled",
    });
  }
  return absentState(signals);
}

async function inspectProjectSignals(project: string): Promise<ProjectSignals> {
  const config = await inspectFallowConfig(project);
  const packageSignals = await inspectPackageJson(project);
  return Object.freeze({
    duplicationConfig: config.duplicationConfig,
    script: packageSignals.script,
    configPresent: config.present,
    dependency: packageSignals.dependency,
    unreadable: config.unreadable || packageSignals.unreadable,
  });
}

async function inspectFallowConfig(project: string): Promise<{
  duplicationConfig?: "enabled" | "disabled";
  present: boolean;
  unreadable: boolean;
}> {
  for (const name of CONFIG_FILES) {
    const file = await readBoundedProjectFile(project, name);
    if (file.status === "missing") continue;
    if (file.status !== "bytes") return { present: true, unreadable: true };
    if (name === ".fallowrc.jsonc" || name === "fallow.toml") {
      return { present: true, unreadable: true };
    }
    return inspectJsonFallowConfig(file.value);
  }
  return { present: false, unreadable: false };
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

async function inspectPackageJson(project: string): Promise<{
  script: boolean;
  dependency: boolean;
  unreadable: boolean;
}> {
  const file = await readBoundedProjectFile(project, "package.json");
  if (file.status === "missing") return { script: false, dependency: false, unreadable: false };
  if (file.status !== "bytes") return { script: false, dependency: false, unreadable: true };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.value));
    if (!isRecord(value)) return { script: false, dependency: false, unreadable: true };
    return {
      script: hasDuplicationScript(value.scripts),
      dependency: hasFallowDependency(value),
      unreadable: false,
    };
  } catch {
    return { script: false, dependency: false, unreadable: true };
  }
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

async function readBoundedProjectFile(project: string, relativePath: string): Promise<BoundedFile> {
  let canonical: string;
  try {
    canonical = await realpath(join(project, relativePath));
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "failed" };
  }
  if (!isPathInside(project, canonical)) return { status: "unsafe" };

  let file: FileHandle;
  try {
    file = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return { status: "failed" };
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) return { status: "failed" };
    if (metadata.size > MAX_SIGNAL_FILE_BYTES) return { status: "too-large" };
    return await readSignalBytes(file, metadata.size);
  } catch {
    return { status: "failed" };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readSignalBytes(file: FileHandle, initialSize: number): Promise<BoundedFile> {
  const buffer = Buffer.alloc(initialSize + 1);
  let total = 0;
  while (total < buffer.length) {
    const read = await file.read(buffer, total, buffer.length - total, total);
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
  }
  if (total > MAX_SIGNAL_FILE_BYTES) return { status: "too-large" };
  return { status: "bytes", value: buffer.subarray(0, total) };
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
