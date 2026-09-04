import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer, MutableRef } from "effect";
import { type JscpdEffectRuntime, JscpdTestEffectRuntime } from "./effect/runtime-boundary.js";
import { JscpdFileSystem } from "./effect/services.js";
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
  startEffect?: (
    cwd: string,
    restored?: readonly string[],
  ) => Effect.Effect<void, never, JscpdFileSystem>;
  /** Invalidate pending path work and clear all in-memory session state. */
  reset(): void;
  /** Record one verified built-in tool result. Returns true only for a newly tracked path. */
  recordToolResult(event: JscpdMutationToolResult, cwd: string): Promise<boolean>;
  /** Record and return the canonical path even when it was already tracked. */
  recordToolResultPath(event: JscpdMutationToolResult, cwd: string): Promise<string | undefined>;
  recordToolResultPathEffect?: (
    event: JscpdMutationToolResult,
    cwd: string,
  ) => Effect.Effect<string | undefined, never, JscpdFileSystem>;
  /** Deterministically sorted canonical project-relative paths. */
  files(): readonly string[];
  readonly filesEffect?: Effect.Effect<readonly string[]>;
}

interface ProjectRoots {
  readonly lexical: string;
  readonly canonical: string;
}

interface TrackerSnapshot {
  readonly generation: number;
  readonly roots: ProjectRoots;
}

interface ChangedFileState {
  readonly generation: number;
  readonly roots?: ProjectRoots;
  readonly files: ReadonlySet<string>;
}

interface JscpdChangedFilesEffectService {
  readonly start: (
    cwd: string,
    restored?: readonly string[],
  ) => Effect.Effect<void, never, JscpdFileSystem>;
  readonly reset: Effect.Effect<void>;
  readonly recordToolResult: (
    event: JscpdMutationToolResult,
    cwd: string,
  ) => Effect.Effect<boolean, never, JscpdFileSystem>;
  readonly recordToolResultPath: (
    event: JscpdMutationToolResult,
    cwd: string,
  ) => Effect.Effect<string | undefined, never, JscpdFileSystem>;
  readonly files: Effect.Effect<readonly string[]>;
}

export const JscpdChangedFiles = Context.GenericTag<JscpdChangedFilesEffectService>(
  "pi-jscpd/effect/ChangedFiles",
);

/**
 * Track a bounded, append-only set of files attributed to successful built-in edit/write results.
 * Tool provenance must be verified by the caller; arbitrary result text and shell output are ignored.
 */
export function createJscpdChangedFileTracker(
  runtime: JscpdEffectRuntime = JscpdTestEffectRuntime,
): JscpdChangedFileTracker {
  return changedFileTrackerFor(new ChangedFileOwner(), runtime);
}

export function createJscpdChangedFilesLayer() {
  const owner = new ChangedFileOwner();
  return Layer.succeed(JscpdChangedFiles, changedFilesEffectServiceFor(owner));
}

class ChangedFileOwner {
  readonly #state = MutableRef.make<ChangedFileState>({ generation: 0, files: new Set<string>() });

  startEffect(
    cwd: string,
    restored: readonly string[] = [],
  ): Effect.Effect<void, never, JscpdFileSystem> {
    return Effect.suspend(() => this.startPreparedEffect(cwd, restored));
  }

  startPreparedEffect(
    cwd: string,
    restored: readonly string[] = [],
  ): Effect.Effect<void, never, JscpdFileSystem> {
    const generation = this.#beginStart(restored);
    return resolveProjectRootsEffect(cwd).pipe(
      Effect.tap((roots) =>
        Effect.sync(() => {
          const current = MutableRef.get(this.#state);
          if (current.generation === generation && roots) {
            MutableRef.set(this.#state, { ...current, roots });
          }
        }),
      ),
      Effect.asVoid,
    );
  }

  reset(): void {
    const current = MutableRef.get(this.#state);
    MutableRef.set(this.#state, {
      generation: current.generation + 1,
      files: new Set<string>(),
    });
  }

  recordEffect(
    event: JscpdMutationToolResult,
    cwd: string,
  ): Effect.Effect<
    { readonly path: string; readonly added: boolean } | undefined,
    never,
    JscpdFileSystem
  > {
    return Effect.suspend(() => {
      const state = MutableRef.get(this.#state);
      const rawPath = successfulMutationPath(event);
      const snapshot = activeTrackerSnapshot(state.generation, state.roots);
      if (!rawPath || !snapshot) return Effect.succeed(undefined);
      return canonicalChangedFileEffect(rawPath, cwd, snapshot.roots).pipe(
        Effect.map((projectPath) => this.#commitMutation(snapshot, projectPath)),
      );
    });
  }

  files(): readonly string[] {
    return Object.freeze([...MutableRef.get(this.#state).files].sort(compareText));
  }

  #beginStart(restored: readonly string[]): number {
    const current = MutableRef.get(this.#state);
    const generation = current.generation + 1;
    MutableRef.set(this.#state, {
      generation,
      files: new Set(restored.slice(0, MAX_CHANGED_FILES).filter(isSafeChangedFilePath)),
    });
    return generation;
  }

  #commitMutation(
    snapshot: TrackerSnapshot,
    projectPath: string | undefined,
  ): { readonly path: string; readonly added: boolean } | undefined {
    const current = MutableRef.get(this.#state);
    if (!projectPath || !isCurrentTrackerSnapshot(snapshot, current.generation, current.roots)) {
      return undefined;
    }
    const alreadyTracked = current.files.has(projectPath);
    const hasCapacity = alreadyTracked || current.files.size < MAX_CHANGED_FILES;
    if (!alreadyTracked && hasCapacity) {
      MutableRef.set(this.#state, { ...current, files: new Set([...current.files, projectPath]) });
    }
    return Object.freeze({ path: projectPath, added: !alreadyTracked && hasCapacity });
  }
}

function changedFileTrackerFor(
  owner: ChangedFileOwner,
  runtime: JscpdEffectRuntime,
): JscpdChangedFileTracker {
  const run = <A>(effect: Effect.Effect<A, never, JscpdFileSystem>) => runtime.runPromise(effect);
  return {
    start: (cwd, restored) => run(owner.startPreparedEffect(cwd, restored)),
    startEffect: (cwd, restored) => owner.startPreparedEffect(cwd, restored),
    reset: () => owner.reset(),
    recordToolResult: (event, cwd) =>
      run(owner.recordEffect(event, cwd)).then((result) => result?.added ?? false),
    recordToolResultPath: (event, cwd) =>
      run(owner.recordEffect(event, cwd)).then((result) => result?.path),
    recordToolResultPathEffect: (event, cwd) =>
      owner.recordEffect(event, cwd).pipe(Effect.map((result) => result?.path)),
    files: () => owner.files(),
    filesEffect: Effect.sync(() => owner.files()),
  };
}

function changedFilesEffectServiceFor(owner: ChangedFileOwner): JscpdChangedFilesEffectService {
  return {
    start: (cwd, restored) => owner.startEffect(cwd, restored),
    reset: Effect.sync(() => owner.reset()),
    recordToolResult: (event, cwd) =>
      owner.recordEffect(event, cwd).pipe(Effect.map((result) => result?.added ?? false)),
    recordToolResultPath: (event, cwd) =>
      owner.recordEffect(event, cwd).pipe(Effect.map((result) => result?.path)),
    files: Effect.sync(() => owner.files()),
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

function resolveProjectRootsEffect(
  cwd: string,
): Effect.Effect<ProjectRoots | undefined, never, JscpdFileSystem> {
  if (!isSafeRawPath(cwd) || !isAbsolute(cwd)) return Effect.succeed(undefined);
  const lexical = resolve(cwd);
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    Effect.flatMap(filesystem.canonicalize(lexical), (canonical) =>
      Effect.map(filesystem.metadata(canonical), (metadata) => ({ canonical, metadata })),
    ),
  ).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: ({ canonical, metadata }) =>
        metadata.kind === "directory" && isAbsolute(canonical) && isSafeRawPath(canonical)
          ? Object.freeze({ lexical, canonical })
          : undefined,
    }),
  );
}

function canonicalChangedFileEffect(
  rawPath: string,
  cwd: string,
  roots: ProjectRoots,
): Effect.Effect<string | undefined, never, JscpdFileSystem> {
  const candidate = lexicalChangedFileCandidate(rawPath, cwd, roots);
  if (!candidate) return Effect.succeed(undefined);
  return canonicalRegularFileEffect(candidate).pipe(
    Effect.map((canonical) =>
      canonical && isPathInside(roots.canonical, canonical)
        ? portableProjectPath(roots.canonical, canonical)
        : undefined,
    ),
  );
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

function canonicalRegularFileEffect(
  candidate: string,
): Effect.Effect<string | undefined, never, JscpdFileSystem> {
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    Effect.flatMap(filesystem.canonicalize(candidate), (canonical) =>
      Effect.map(filesystem.metadata(canonical), (metadata) =>
        metadata.kind === "file" ? canonical : undefined,
      ),
    ),
  ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
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
