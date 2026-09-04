import { isAbsolute, relative, sep } from "node:path";
import { Effect, Exit } from "effect";
import { JscpdFileSystemLive } from "./effect/filesystem.js";
import { runEffectExitAtApplicationBoundary } from "./effect/runtime-boundary.js";
import { JscpdFileSystem } from "./effect/services.js";

/** Resolve an existing absolute directory through the injected bounded filesystem. */
export function canonicalDirectoryEffect(cwd: string) {
  if (!isAbsolute(cwd)) return Effect.succeed<string | undefined>(undefined);
  return Effect.flatMap(JscpdFileSystem, (filesystem) =>
    Effect.all([filesystem.canonicalize(cwd), filesystem.metadata(cwd)], {
      concurrency: "unbounded",
    }),
  ).pipe(
    Effect.map(([canonical, metadata]) => (metadata.kind === "directory" ? canonical : undefined)),
  );
}

/** Temporary Promise facade retained until application workflows use the managed Effect runtime. */
export async function canonicalDirectory(cwd: string): Promise<string | undefined> {
  const exit = await runEffectExitAtApplicationBoundary(
    canonicalDirectoryEffect(cwd).pipe(Effect.provide(JscpdFileSystemLive)),
  );
  return Exit.isSuccess(exit) ? exit.value : undefined;
}

/** Reject control characters before paths or labels reach filesystem APIs. */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/** Test containment without treating a sibling path with the same prefix as a child. */
export function isPathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
