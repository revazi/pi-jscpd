import { isAbsolute, relative, sep } from "node:path";
import { Effect } from "effect";
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

/** Resolve a canonical directory and collapse filesystem failures at the application edge. */
export function optionalCanonicalDirectoryEffect(cwd: string) {
  return canonicalDirectoryEffect(cwd).pipe(
    Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
  );
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
