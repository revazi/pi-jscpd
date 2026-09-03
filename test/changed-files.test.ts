import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJscpdChangedFileTracker,
  MAX_CHANGED_FILE_PATH_BYTES,
  MAX_CHANGED_FILES,
  normalizeWindowsShellPath,
} from "../src/changed-files.js";

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-changed-files-test-"));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(outside);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function result(
  toolName: string,
  path: unknown,
  isError = false,
): { toolName: string; input: Record<string, unknown>; isError: boolean } {
  return { toolName, input: { path }, isError };
}

describe("Pi tool path normalization", () => {
  it.each([
    ["/c/project/src/file.ts", "C:\\project\\src\\file.ts"],
    ["/mnt/d/project/src/file.ts", "D:\\project\\src\\file.ts"],
    ["/cygdrive/e/project/src/file.ts", "E:\\project\\src\\file.ts"],
    ["/C", "C:\\"],
  ])("normalizes a Windows shell drive path %s", (input, expected) => {
    expect(normalizeWindowsShellPath(input)).toBe(expected);
  });

  it.each(["//server/share/file.ts", "/project/src/file.ts", "/c/mixed\\file.ts", "src/file.ts"])(
    "leaves a non-drive Windows shell path unchanged: %s",
    (input) => {
      expect(normalizeWindowsShellPath(input)).toBe(input);
    },
  );
});

describe("session-owned changed-file tracking", () => {
  it("records successful structured edit/write results as sorted project-relative paths", async () => {
    await writeFile(join(project, "src", "z.ts"), "export const z = 1;\n");
    await writeFile(join(project, "src", "a.ts"), "export const a = 1;\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(tracker.recordToolResult(result("write", "src/z.ts"), project)).resolves.toBe(
      true,
    );
    await expect(
      tracker.recordToolResult(result("edit", join(project, "src", "a.ts")), project),
    ).resolves.toBe(true);

    expect(tracker.files()).toEqual(["src/a.ts", "src/z.ts"]);
    expect(Object.isFrozen(tracker.files())).toBe(true);
  });

  it("deduplicates repeated edits and Pi's leading-at path normalization", async () => {
    await writeFile(join(project, "src", "same.ts"), "one\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(tracker.recordToolResult(result("edit", "src/same.ts"), project)).resolves.toBe(
      true,
    );
    await expect(tracker.recordToolResult(result("write", "@src/same.ts"), project)).resolves.toBe(
      false,
    );

    expect(tracker.files()).toEqual(["src/same.ts"]);
  });

  it("uses a canonical project root when the session cwd is a symlink", async () => {
    const projectAlias = join(root, "project-alias");
    const file = join(project, "src", "root-alias.ts");
    await writeFile(file, "alias root\n");
    await symlink(project, projectAlias);
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(projectAlias);

    await expect(
      tracker.recordToolResult(result("write", "src/root-alias.ts"), projectAlias),
    ).resolves.toBe(true);
    expect(tracker.files()).toEqual(["src/root-alias.ts"]);
  });

  it("canonicalizes an in-project symlink alias and rejects a symlink escape", async () => {
    await writeFile(join(project, "src", "target.ts"), "target\n");
    await writeFile(join(outside, "secret.ts"), "outside\n");
    await symlink(join(project, "src", "target.ts"), join(project, "alias.ts"));
    await symlink(join(outside, "secret.ts"), join(project, "escape.ts"));
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(tracker.recordToolResult(result("edit", "alias.ts"), project)).resolves.toBe(true);
    await expect(tracker.recordToolResult(result("edit", "escape.ts"), project)).resolves.toBe(
      false,
    );

    expect(tracker.files()).toEqual(["src/target.ts"]);
  });

  it.each([
    ["failed edit", "edit", "src/file.ts", true],
    ["shell mutation", "bash", "src/file.ts", false],
    ["read-only tool", "read", "src/file.ts", false],
    ["missing path input", "edit", undefined, false],
    ["control character", "write", "src/bad\nname.ts", false],
    ["malformed file URL", "write", "file://%", false],
    ["missing post-result file", "write", "src/missing.ts", false],
    ["directory target", "edit", "src", false],
    ["lexical escape", "write", "../outside/secret.ts", false],
  ])("ignores %s", async (_label, toolName, path, isError) => {
    await writeFile(join(project, "src", "file.ts"), "file\n");
    await writeFile(join(outside, "secret.ts"), "outside\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(tracker.recordToolResult(result(toolName, path, isError), project)).resolves.toBe(
      false,
    );
    expect(tracker.files()).toEqual([]);
  });

  it("ignores malformed event objects fail-open", async () => {
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(
      tracker.recordToolResult({ toolName: "write", input: null, isError: false }, project),
    ).resolves.toBe(false);
    await expect(
      tracker.recordToolResult(
        { toolName: "write", input: { path: "src/file.ts" }, isError: undefined },
        project,
      ),
    ).resolves.toBe(false);
    await expect(
      tracker.recordToolResult({ toolName: 1, input: [], isError: false }, project),
    ).resolves.toBe(false);
    expect(tracker.files()).toEqual([]);
  });

  it("rejects absolute outside paths and overlong input without exposing filesystem data", async () => {
    const outsideFile = join(outside, "secret.ts");
    await writeFile(outsideFile, "outside\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    await expect(tracker.recordToolResult(result("write", outsideFile), project)).resolves.toBe(
      false,
    );
    await expect(
      tracker.recordToolResult(
        result("write", `src/${"x".repeat(MAX_CHANGED_FILE_PATH_BYTES)}.ts`),
        project,
      ),
    ).resolves.toBe(false);
    expect(tracker.files()).toEqual([]);
  });

  it("keeps rename sources conservatively and records a destination only after its own result", async () => {
    const source = join(project, "src", "before.ts");
    const destination = join(project, "src", "after.ts");
    await writeFile(source, "before\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);
    await tracker.recordToolResult(result("write", source), project);

    await rename(source, destination);
    expect(tracker.files()).toEqual(["src/before.ts"]);
    await expect(tracker.recordToolResult(result("bash", destination), project)).resolves.toBe(
      false,
    );
    await expect(tracker.recordToolResult(result("edit", destination), project)).resolves.toBe(
      true,
    );

    expect(tracker.files()).toEqual(["src/after.ts", "src/before.ts"]);
  });

  it("restores only safe bounded paths and resets when the active project changes", async () => {
    const otherProject = join(root, "other-project");
    await mkdir(otherProject);
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, ["src/restored.ts", "../unsafe.ts", "src/restored.ts"]);
    expect(tracker.files()).toEqual(["src/restored.ts"]);

    await tracker.start(otherProject, ["other.ts"]);
    expect(tracker.files()).toEqual(["other.ts"]);
    tracker.reset();
    expect(tracker.files()).toEqual([]);
  });

  it("does not exceed the persisted changed-file bound", async () => {
    const restored = Array.from({ length: MAX_CHANGED_FILES }, (_, index) => `src/${index}.ts`);
    const extra = join(project, "src", "extra.ts");
    await writeFile(extra, "extra\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project, restored);

    await expect(tracker.recordToolResult(result("write", extra), project)).resolves.toBe(false);
    await expect(tracker.recordToolResultPath(result("write", extra), project)).resolves.toBe(
      "src/extra.ts",
    );
    expect(tracker.files()).toHaveLength(MAX_CHANGED_FILES);
  });

  it("fails open when the project root is unavailable or the event cwd changes", async () => {
    const file = join(project, "src", "file.ts");
    await writeFile(file, "file\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(resolve(root, "missing"));
    await expect(tracker.recordToolResult(result("write", file), project)).resolves.toBe(false);

    await tracker.start(project);
    await expect(tracker.recordToolResult(result("write", file), outside)).resolves.toBe(false);
    await expect(tracker.recordToolResult(result("write", file), "relative-cwd")).resolves.toBe(
      false,
    );
    expect(tracker.files()).toEqual([]);
  });

  it("discards a path resolution that becomes stale after reset", async () => {
    const file = join(project, "src", "stale.ts");
    await writeFile(file, "stale\n");
    const tracker = createJscpdChangedFileTracker();
    await tracker.start(project);

    const pendingResult = tracker.recordToolResult(result("write", file), project);
    tracker.reset();

    await expect(pendingResult).resolves.toBe(false);
    expect(tracker.files()).toEqual([]);
  });
});
