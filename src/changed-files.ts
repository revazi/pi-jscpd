import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareText, hasControlCharacters, isPathInside } from "./path-utils.js";

export const MAX_CHANGED_FILES = 1_000;
export const MAX_CHANGED_FILE_PATH_BYTES = 4_096;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const MUTATION_TOOL_NAMES = new Set(["edit", "write"]);

export interface JscpdMutationToolResult {
  readonly toolName: unknown;
  readonly input: unknown;
  readonly isError: unknown;
}

export interface JscpdChangedFileTracker {
  /** Bind the tracker to one project and restore only its active-branch snapshot. */
  start(cwd: string, restored?: readonly string[]): Promise<void>;
  /** Invalidate pending path work and clear all in-memory session state. */
  reset(): void;
  /** Record one verified built-in tool result. Returns true only for a newly tracked path. */
  recordToolResult(event: JscpdMutationToolResult, cwd: string): Promise<boolean>;
  /** Deterministically sorted canonical project-relative paths. */
  files(): readonly string[];
}

interface ProjectRoots {
  readonly lexical: string;
  readonly canonical: string;
}

interface TrackerSnapshot {
  readonly generation: number;
  readonly roots: ProjectRoots;
}

/**
 * Track a bounded, append-only set of files attributed to successful built-in edit/write results.
 * Tool provenance must be verified by the caller; arbitrary result text and shell output are ignored.
 */
export function createJscpdChangedFileTracker(): JscpdChangedFileTracker {
  let generation = 0;
  let roots: ProjectRoots | undefined;
  let changedFiles = new Set<string>();

  return {
    async start(cwd, restored = []) {
      generation += 1;
      const currentGeneration = generation;
      roots = undefined;
      changedFiles = new Set(restored.slice(0, MAX_CHANGED_FILES).filter(isSafeChangedFilePath));

      const projectRoots = await resolveProjectRoots(cwd);
      if (generation !== currentGeneration || !projectRoots) return;

      roots = projectRoots;
    },
    reset() {
      generation += 1;
      roots = undefined;
      changedFiles = new Set();
    },
    async recordToolResult(event, cwd) {
      const rawPath = successfulMutationPath(event);
      const snapshot = activeTrackerSnapshot(generation, roots);
      if (!rawPath || !snapshot) return false;

      const projectPath = await canonicalChangedFile(rawPath, cwd, snapshot.roots);
      if (!projectPath || !isCurrentTrackerSnapshot(snapshot, generation, roots)) return false;

      return addChangedFile(changedFiles, projectPath);
    },
    files() {
      return Object.freeze([...changedFiles].sort(compareText));
    },
  };
}

/** Validate the portable path shape accepted in persisted session snapshots. */
export function isSafeChangedFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_CHANGED_FILE_PATH_BYTES ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function resolveProjectRoots(cwd: string): Promise<ProjectRoots | undefined> {
  if (!isSafeRawPath(cwd) || !isAbsolute(cwd)) return undefined;
  try {
    const lexical = resolve(cwd);
    const canonical = await realpath(lexical);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() || !isAbsolute(canonical) || !isSafeRawPath(canonical)) {
      return undefined;
    }
    return Object.freeze({ lexical, canonical });
  } catch {
    return undefined;
  }
}

async function canonicalChangedFile(
  rawPath: string,
  cwd: string,
  roots: ProjectRoots,
): Promise<string | undefined> {
  const candidate = lexicalChangedFileCandidate(rawPath, cwd, roots);
  if (!candidate) return undefined;

  const canonical = await canonicalRegularFile(candidate);
  if (!canonical || !isPathInside(roots.canonical, canonical)) return undefined;

  return portableProjectPath(roots.canonical, canonical);
}

function lexicalChangedFileCandidate(
  rawPath: string,
  cwd: string,
  roots: ProjectRoots,
): string | undefined {
  const normalizedPath = safeNormalizedToolPath(rawPath);
  const lexicalCwd = matchingProjectCwd(cwd, roots);
  if (!normalizedPath || !lexicalCwd) return undefined;

  const candidate = resolve(lexicalCwd, normalizedPath);
  return isInsideEitherProjectRoot(candidate, lexicalCwd, roots.canonical) ? candidate : undefined;
}

function safeNormalizedToolPath(rawPath: string): string | undefined {
  if (!isSafeRawPath(rawPath)) return undefined;
  try {
    const normalizedPath = normalizePiToolPath(rawPath);
    return isSafeRawPath(normalizedPath) ? normalizedPath : undefined;
  } catch {
    return undefined;
  }
}

function matchingProjectCwd(cwd: string, roots: ProjectRoots): string | undefined {
  if (!isSafeRawPath(cwd) || !isAbsolute(cwd)) return undefined;
  const lexicalCwd = resolve(cwd);
  return lexicalCwd === roots.lexical || lexicalCwd === roots.canonical ? lexicalCwd : undefined;
}

function isInsideEitherProjectRoot(
  candidate: string,
  lexicalRoot: string,
  canonicalRoot: string,
): boolean {
  return isPathInside(lexicalRoot, candidate) || isPathInside(canonicalRoot, candidate);
}

async function canonicalRegularFile(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function portableProjectPath(projectRoot: string, canonical: string): string | undefined {
  const projectRelative = relative(projectRoot, canonical);
  const portable = sep === "/" ? projectRelative : projectRelative.split(sep).join("/");
  return isSafeChangedFilePath(portable) ? portable : undefined;
}

function normalizePiToolPath(value: string): string {
  let normalized = value.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  if (normalized === "~") return homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Match Pi's conversion of Git Bash, MSYS, Cygwin, and WSL drive paths on Windows. */
export function normalizeWindowsShellPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return value;
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]?.toUpperCase()}:\\${suffix ?? ""}`;
}

function successfulMutationPath(event: JscpdMutationToolResult): string | undefined {
  if (event.isError !== false || !isMutationToolName(event.toolName) || !isRecord(event.input)) {
    return undefined;
  }
  return typeof event.input.path === "string" ? event.input.path : undefined;
}

function isMutationToolName(value: unknown): value is string {
  return typeof value === "string" && MUTATION_TOOL_NAMES.has(value);
}

function activeTrackerSnapshot(
  generation: number,
  roots: ProjectRoots | undefined,
): TrackerSnapshot | undefined {
  return roots ? { generation, roots } : undefined;
}

function isCurrentTrackerSnapshot(
  snapshot: TrackerSnapshot,
  generation: number,
  roots: ProjectRoots | undefined,
): boolean {
  return snapshot.generation === generation && snapshot.roots === roots;
}

function addChangedFile(changedFiles: Set<string>, projectPath: string): boolean {
  if (changedFiles.has(projectPath) || changedFiles.size >= MAX_CHANGED_FILES) return false;
  changedFiles.add(projectPath);
  return true;
}

function isSafeRawPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_CHANGED_FILE_PATH_BYTES &&
    !hasControlCharacters(value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
