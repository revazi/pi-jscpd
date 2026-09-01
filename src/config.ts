import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const PROJECT_CONFIG_FILE_NAME = "jscpd-guardrail.json";
const LOCAL_CONFIG_FILE_NAME = "jscpd-guardrail.local.json";
const MAX_CONFIG_BYTES = 64 * 1_024;
const CONFIG_READ_CHUNK_BYTES = 8 * 1_024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_PRESENTED_FINDINGS = 100;

export const DEFAULT_JSCPD_CONFIG: JscpdConfig = Object.freeze({
  enabled: true,
  timeoutMs: 30_000,
  maxFindings: 10,
});

export interface JscpdConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxFindings: number;
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
  load(context: JscpdConfigLoadContext): Promise<JscpdConfigLoadResult>;
  current(): JscpdConfigLoadResult;
}

interface ConfigPatch {
  enabled?: boolean;
  timeoutMs?: number;
  maxFindings?: number;
}
type ConfigFileSource = Exclude<JscpdConfigSource, "defaults">;

type ConfigFileResult =
  | { status: "missing" }
  | { status: "valid"; patch: ConfigPatch }
  | { status: "invalid"; diagnostic: JscpdConfigDiagnostic };

const SOURCE_FILES: readonly [ConfigFileSource, string][] = [
  ["project", PROJECT_CONFIG_FILE_NAME],
  ["local", LOCAL_CONFIG_FILE_NAME],
];

export function createJscpdConfigService(): JscpdConfigService {
  let loaded = defaultLoadResult(false);
  return {
    async load(context) {
      loaded = await loadJscpdConfig(context);
      return loaded;
    },
    current() {
      return loaded;
    },
  };
}

async function loadJscpdConfig(context: JscpdConfigLoadContext): Promise<JscpdConfigLoadResult> {
  if (!context.trusted) {
    return defaultLoadResult(false);
  }

  const projectDirectory = await canonicalProjectDirectory(context.cwd);
  if (!projectDirectory) {
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

  const config: JscpdConfig = { ...DEFAULT_JSCPD_CONFIG };
  const sources: JscpdConfigSource[] = ["defaults"];
  const diagnostics: JscpdConfigDiagnostic[] = [];
  for (const [source, fileName] of SOURCE_FILES) {
    const result = await loadConfigFile(projectDirectory, source, fileName);
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
}

async function canonicalProjectDirectory(cwd: string): Promise<string | undefined> {
  if (!isAbsolute(cwd)) {
    return undefined;
  }
  try {
    const [canonical, metadata] = await Promise.all([realpath(cwd), stat(cwd)]);
    return metadata.isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfigFile(
  projectDirectory: string,
  source: ConfigFileSource,
  fileName: string,
): Promise<ConfigFileResult> {
  const configuredPath = join(projectDirectory, CONFIG_DIR_NAME, fileName);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(configuredPath);
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    return missing
      ? { status: "missing" }
      : invalidFile(
          source,
          "read-failed",
          `${sourceLabel(source)} could not be read and was ignored.`,
        );
  }

  if (!isPathInside(projectDirectory, canonicalPath)) {
    return invalidFile(
      source,
      "unsafe-file",
      `${sourceLabel(source)} resolves outside the project and was ignored.`,
    );
  }

  const bytes = await readBoundedConfig(canonicalPath);
  if (bytes.status === "too-large") {
    return invalidFile(
      source,
      "file-too-large",
      `${sourceLabel(source)} exceeds the 64 KiB limit and was ignored.`,
    );
  }
  if (bytes.status === "failed") {
    return invalidFile(
      source,
      "read-failed",
      `${sourceLabel(source)} could not be read and was ignored.`,
    );
  }
  return parseConfigFile(bytes.value, source);
}

type ConfigBytesResult =
  | { status: "bytes"; value: Uint8Array }
  | { status: "too-large" }
  | { status: "failed" };

async function readBoundedConfig(path: string): Promise<ConfigBytesResult> {
  let file: FileHandle;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return { status: "failed" };
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      return { status: "failed" };
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      return { status: "too-large" };
    }
    return await readConfigChunks(file);
  } catch {
    return { status: "failed" };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readConfigChunks(file: FileHandle): Promise<ConfigBytesResult> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (bytesRead <= MAX_CONFIG_BYTES) {
    const capacity = Math.min(CONFIG_READ_CHUNK_BYTES, MAX_CONFIG_BYTES - bytesRead + 1);
    const chunk = Buffer.alloc(capacity);
    const read = await file.read(chunk, 0, capacity, null);
    if (read.bytesRead === 0) {
      return { status: "bytes", value: Buffer.concat(chunks, bytesRead) };
    }
    chunks.push(chunk.subarray(0, read.bytesRead));
    bytesRead += read.bytesRead;
  }
  return { status: "too-large" };
}

function parseConfigFile(bytes: Uint8Array, source: ConfigFileSource): ConfigFileResult {
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

  const patch: ConfigPatch = {};
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (typeof value.timeoutMs === "number") patch.timeoutMs = value.timeoutMs;
  if (typeof value.maxFindings === "number") patch.maxFindings = value.maxFindings;
  return { status: "valid", patch: Object.freeze(patch) };
}

function isValidConfigValue(field: keyof JscpdConfig, value: unknown): boolean {
  switch (field) {
    case "enabled":
      return typeof value === "boolean";
    case "timeoutMs":
      return isBoundedInteger(value, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    case "maxFindings":
      return isBoundedInteger(value, 1, MAX_PRESENTED_FINDINGS);
  }
}

function knownFields(): readonly (keyof JscpdConfig)[] {
  return ["enabled", "timeoutMs", "maxFindings"];
}

function isKnownConfigField(field: string): field is keyof JscpdConfig {
  return field === "enabled" || field === "timeoutMs" || field === "maxFindings";
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
): ConfigFileResult {
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
