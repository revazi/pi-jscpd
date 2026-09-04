import { isAbsolute, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Context, Data, Effect, Layer } from "effect";
import { JscpdFileSystem } from "./effect/services.js";
import { canonicalDirectoryEffect } from "./path-utils.js";

const PROJECT_CONFIG_FILE_NAME = "jscpd-guardrail.json";
const LOCAL_CONFIG_FILE_NAME = "jscpd-guardrail.local.json";
const MAX_CONFIG_BYTES = 64 * 1_024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_PRESENTED_FINDINGS = 100;

export const DEFAULT_JSCPD_CONFIG: JscpdConfig = Object.freeze({
  enabled: true,
  timeoutMs: 30_000,
  maxFindings: 10,
  fallowCoexistence: "auto",
});

export interface JscpdConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxFindings: number;
  readonly fallowCoexistence?: "auto" | "on-demand" | "allow";
}

export type JscpdConfigSource = "defaults" | "project" | "local";

export type JscpdConfigDiagnosticCode =
  | "invalid-project"
  | "unsafe-file"
  | "read-failed"
  | "file-too-large"
  | "malformed-json"
  | "invalid-top-level"
  | "unknown-field"
  | "invalid-value";

export interface JscpdConfigDiagnostic {
  readonly source: Exclude<JscpdConfigSource, "defaults">;
  readonly code: JscpdConfigDiagnosticCode;
  readonly message: string;
}

export interface JscpdConfigLoadResult {
  readonly config: JscpdConfig;
  /** Lowest-to-highest precedence; local values override project values. */
  readonly sources: readonly JscpdConfigSource[];
  readonly diagnostics: readonly JscpdConfigDiagnostic[];
  readonly trusted: boolean;
}

export interface JscpdConfigLoadContext {
  readonly cwd: string;
  readonly trusted: boolean;
}

export interface JscpdConfigService {
  loadEffect: (
    context: JscpdConfigLoadContext,
  ) => Effect.Effect<JscpdConfigLoadResult, never, JscpdFileSystem>;
  current(): JscpdConfigLoadResult;
}

interface JscpdConfigEffectService {
  readonly load: (
    context: JscpdConfigLoadContext,
  ) => Effect.Effect<JscpdConfigLoadResult, never, JscpdFileSystem>;
  readonly current: Effect.Effect<JscpdConfigLoadResult>;
}

export const JscpdConfiguration = Context.GenericTag<JscpdConfigEffectService>(
  "pi-jscpd/effect/Configuration",
);

interface ConfigPatch {
  enabled?: boolean;
  timeoutMs?: number;
  maxFindings?: number;
  fallowCoexistence?: "auto" | "on-demand" | "allow";
}
type ConfigFileSource = Exclude<JscpdConfigSource, "defaults">;

type ConfigFileResult =
  | { status: "missing" }
  | { status: "valid"; patch: ConfigPatch }
  | { status: "invalid"; diagnostic: JscpdConfigDiagnostic };

class ConfigDecodeFailure extends Data.TaggedError("ConfigDecodeFailure")<{
  readonly diagnostic: JscpdConfigDiagnostic;
}> {}

const SOURCE_FILES: readonly [ConfigFileSource, string][] = [
  ["project", PROJECT_CONFIG_FILE_NAME],
  ["local", LOCAL_CONFIG_FILE_NAME],
];

export function createJscpdConfigService(): JscpdConfigService {
  const owner = new DefaultJscpdConfigService();
  return {
    loadEffect: (context) => owner.loadEffect(context),
    current: () => owner.currentValue(),
  };
}

export function createJscpdConfigLayer() {
  const owner = new DefaultJscpdConfigService();
  return Layer.succeed(JscpdConfiguration, {
    load: (context) => owner.loadEffect(context),
    current: Effect.sync(() => owner.currentValue()),
  });
}

class DefaultJscpdConfigService {
  #loaded = defaultLoadResult(false);

  loadEffect(
    context: JscpdConfigLoadContext,
  ): Effect.Effect<JscpdConfigLoadResult, never, JscpdFileSystem> {
    return loadJscpdConfigEffect(context).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          this.#loaded = loaded;
        }),
      ),
    );
  }

  currentValue(): JscpdConfigLoadResult {
    return this.#loaded;
  }
}

export function loadJscpdConfigEffect(
  context: JscpdConfigLoadContext,
): Effect.Effect<JscpdConfigLoadResult, never, JscpdFileSystem> {
  if (!context.trusted) return Effect.succeed(defaultLoadResult(false));
  return Effect.gen(function* () {
    const projectDirectory = yield* canonicalDirectoryEffect(context.cwd).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    if (!projectDirectory) return invalidProjectResult();

    const config: JscpdConfig = { ...DEFAULT_JSCPD_CONFIG };
    const sources: JscpdConfigSource[] = ["defaults"];
    const diagnostics: JscpdConfigDiagnostic[] = [];
    for (const [source, fileName] of SOURCE_FILES) {
      const result = yield* loadConfigFileEffect(projectDirectory, source, fileName);
      if (result.status === "valid") {
        Object.assign(config, result.patch);
        sources.push(source);
      } else if (result.status === "invalid") {
        diagnostics.push(result.diagnostic);
      }
    }
    return Object.freeze({
      config: Object.freeze(config),
      sources: Object.freeze(sources),
      diagnostics: Object.freeze(diagnostics),
      trusted: true,
    });
  });
}

function loadConfigFileEffect(
  projectDirectory: string,
  source: ConfigFileSource,
  fileName: string,
): Effect.Effect<ConfigFileResult, never, JscpdFileSystem> {
  return Effect.flatMap(JscpdFileSystem, (filesystem) => {
    const configuredPath = join(projectDirectory, CONFIG_DIR_NAME, fileName);
    return filesystem.canonicalize(configuredPath).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            error.reason === "missing"
              ? ({ status: "missing" } as const)
              : unreadableConfigFile(source),
          ),
        onSuccess: (canonicalPath) =>
          isPathInside(projectDirectory, canonicalPath)
            ? readConfigFileEffect(filesystem, canonicalPath, source)
            : Effect.succeed(
                invalidFile(
                  source,
                  "unsafe-file",
                  `${sourceLabel(source)} resolves outside the project and was ignored.`,
                ),
              ),
      }),
    );
  });
}

function readConfigFileEffect(
  filesystem: JscpdFileSystem,
  path: string,
  source: ConfigFileSource,
): Effect.Effect<ConfigFileResult> {
  return filesystem
    .read({
      path,
      maxBytes: MAX_CONFIG_BYTES,
      regularFileOnly: true,
      noFollow: true,
      limitSubject: "configuration",
    })
    .pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            error._tag === "JscpdLimitExceeded"
              ? invalidFile(
                  source,
                  "file-too-large",
                  `${sourceLabel(source)} exceeds the 64 KiB limit and was ignored.`,
                )
              : unreadableConfigFile(source),
          ),
        onSuccess: (bytes) =>
          decodeConfigFileEffect(bytes, source).pipe(
            Effect.match({
              onFailure: (error): ConfigFileResult => ({
                status: "invalid",
                diagnostic: error.diagnostic,
              }),
              onSuccess: (patch): ConfigFileResult => ({ status: "valid", patch }),
            }),
          ),
      }),
    );
}

function invalidProjectResult(): JscpdConfigLoadResult {
  return Object.freeze({
    config: DEFAULT_JSCPD_CONFIG,
    sources: Object.freeze(["defaults"] as const),
    diagnostics: Object.freeze([
      diagnostic(
        "project",
        "invalid-project",
        "jscpd configuration was not loaded because the project directory is unavailable.",
      ),
    ]),
    trusted: true,
  });
}

function unreadableConfigFile(source: ConfigFileSource): ConfigFileResult {
  return invalidFile(
    source,
    "read-failed",
    `${sourceLabel(source)} could not be read and was ignored.`,
  );
}

function decodeConfigFileEffect(
  bytes: Uint8Array,
  source: ConfigFileSource,
): Effect.Effect<ConfigPatch, ConfigDecodeFailure> {
  const decoded = parseConfigFile(bytes, source);
  return decoded.status === "valid"
    ? Effect.succeed(decoded.patch)
    : Effect.fail(new ConfigDecodeFailure({ diagnostic: decoded.diagnostic }));
}

function parseConfigFile(
  bytes: Uint8Array,
  source: ConfigFileSource,
): Exclude<ConfigFileResult, { status: "missing" }> {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return invalidFile(
      source,
      "malformed-json",
      `${sourceLabel(source)} contains malformed JSON and was ignored.`,
    );
  }

  if (!isRecord(value)) {
    return invalidFile(
      source,
      "invalid-top-level",
      `${sourceLabel(source)} must contain a JSON object and was ignored.`,
    );
  }

  const unknown = Object.keys(value).filter((field) => !isKnownConfigField(field));
  if (unknown.length > 0) {
    return invalidFile(
      source,
      "unknown-field",
      `${sourceLabel(source)} contains unknown ${plural(unknown.length, "setting")}: ${boundedFieldList(unknown)}. The file was ignored.`,
    );
  }

  const invalid = knownFields().filter(
    (field) => Object.hasOwn(value, field) && !isValidConfigValue(field, value[field]),
  );
  if (invalid.length > 0) {
    return invalidFile(
      source,
      "invalid-value",
      `${sourceLabel(source)} has invalid ${plural(invalid.length, "value")} for ${boundedFieldList(invalid)}. The file was ignored.`,
    );
  }

  return { status: "valid", patch: configPatch(value) };
}

function configPatch(value: Record<string, unknown>): ConfigPatch {
  const patch: ConfigPatch = {};
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (typeof value.timeoutMs === "number") patch.timeoutMs = value.timeoutMs;
  if (typeof value.maxFindings === "number") patch.maxFindings = value.maxFindings;
  if (
    value.fallowCoexistence === "auto" ||
    value.fallowCoexistence === "on-demand" ||
    value.fallowCoexistence === "allow"
  ) {
    patch.fallowCoexistence = value.fallowCoexistence;
  }
  return Object.freeze(patch);
}

function isValidConfigValue(field: keyof JscpdConfig, value: unknown): boolean {
  switch (field) {
    case "enabled":
      return typeof value === "boolean";
    case "timeoutMs":
      return isBoundedInteger(value, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    case "maxFindings":
      return isBoundedInteger(value, 1, MAX_PRESENTED_FINDINGS);
    case "fallowCoexistence":
      return value === "auto" || value === "on-demand" || value === "allow";
  }
}

function knownFields(): readonly (keyof JscpdConfig)[] {
  return ["enabled", "timeoutMs", "maxFindings", "fallowCoexistence"];
}

function isKnownConfigField(field: string): field is keyof JscpdConfig {
  return (
    field === "enabled" ||
    field === "timeoutMs" ||
    field === "maxFindings" ||
    field === "fallowCoexistence"
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFile(
  source: ConfigFileSource,
  code: JscpdConfigDiagnosticCode,
  message: string,
): Extract<ConfigFileResult, { status: "invalid" }> {
  return { status: "invalid", diagnostic: diagnostic(source, code, message) };
}

function diagnostic(
  source: ConfigFileSource,
  code: JscpdConfigDiagnosticCode,
  message: string,
): JscpdConfigDiagnostic {
  return Object.freeze({ source, code, message });
}

function defaultLoadResult(trusted: boolean): JscpdConfigLoadResult {
  return Object.freeze({
    config: DEFAULT_JSCPD_CONFIG,
    sources: Object.freeze(["defaults"] as const),
    diagnostics: Object.freeze([]),
    trusted,
  });
}

function sourceLabel(source: ConfigFileSource): string {
  return source === "project" ? "Project jscpd configuration" : "Local jscpd configuration";
}

function boundedFieldList(fields: readonly string[]): string {
  const shown = fields.slice(0, 5).map((field) => JSON.stringify(boundedField(field)));
  return fields.length > shown.length
    ? `${shown.join(", ")} and ${fields.length - shown.length} more`
    : shown.join(", ");
}

function boundedField(field: string): string {
  const characters = Array.from(field);
  return characters.length <= 80 ? field : `${characters.slice(0, 79).join("")}…`;
}

function plural(count: number, singular: string): string {
  return `${singular}${count === 1 ? "" : "s"}`;
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}
