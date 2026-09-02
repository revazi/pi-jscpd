import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** Resolve an existing absolute directory without exposing filesystem errors. */
export async function canonicalDirectory(cwd: string): Promise<string | undefined> {
  if (!isAbsolute(cwd)) return undefined;
  try {
    const [canonical, metadata] = await Promise.all([realpath(cwd), stat(cwd)]);
    return metadata.isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
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
