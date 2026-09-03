import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJscpdCapabilityService } from "../src/capability.js";
import { dispatchJscpdCommand } from "../src/dispatch.js";
import { createJscpdSlashCommandDefinition, createJscpdToolDefinition } from "../src/extension.js";
import { createJscpdService, type JscpdService } from "../src/jscpd.js";
import { createJscpdScanExecutor } from "../src/scan.js";
import type { JscpdCommandExecutor } from "../src/types.js";

const FAKE_JSCPD_SOURCE = (node: string, project: string) => `#!${node}
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
function main() {
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("jscpd 5.1.1\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output");
const separatorIndex = args.indexOf("--");
const output = args[outputIndex + 1];
const targets = args.slice(separatorIndex + 1);
appendFileSync(join(__dirname, "calls.jsonl"), JSON.stringify({
  args,
  config: existsSync(join(process.cwd(), ".jscpd.json")),
  cwd: process.cwd() === ${JSON.stringify(project)},
}) + "\\n");
const mode = targets[0];
if (mode === "timeout" || mode === "cancel") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
  return;
}
if (mode === "fail") {
  process.stderr.write("private source and environment details");
  process.exit(7);
}
if (mode === "no-report") process.exit(0);
if (mode === "malformed") {
  writeFileSync(join(output, "jscpd-report.json"), "{ private source fragment");
  process.exit(0);
}
if (mode === "invalid") {
  writeFileSync(join(output, "jscpd-report.json"), JSON.stringify({ duplicates: [], statistics: {} }));
  process.exit(0);
}
const row = (clones) => ({
  clones,
  duplicatedLines: clones,
  duplicatedTokens: clones * 4,
  lines: clones ? 2 : 0,
  newClones: 0,
  newDuplicatedLines: 0,
  percentage: clones ? 50 : 0,
  percentageTokens: clones ? 50 : 0,
  sources: clones ? 2 : 0,
  tokens: clones ? 8 : 0,
});
const clean = mode === "clean";
const duplicates = clean ? [] : [{
  firstFile: {
    end: 1,
    endLoc: { column: 17, line: 1, position: 17 },
    name: "lib/b.ts",
    start: 1,
    startLoc: { column: 0, line: 1, position: 0 },
  },
  format: "typescript",
  fragment: "synthetic fixture",
  lines: 1,
  secondFile: {
    end: 1,
    endLoc: { column: 17, line: 1, position: 17 },
    name: "src/a.ts",
    start: 1,
    startLoc: { column: 0, line: 1, position: 0 },
  },
  tokens: 4,
}];
const report = {
  duplicates,
  statistics: {
    detectionDate: "2026-09-01T00:00:00Z",
    formats: clean ? {} : { typescript: row(1) },
    total: row(clean ? 0 : 1),
  },
};
writeFileSync(join(output, "jscpd-report.json"), JSON.stringify(report));
if (mode === "positive") process.exitCode = 1;
}
main();
`;

interface FakeCall {
  args: string[];
  config: boolean;
  cwd: boolean;
}

let root: string;
let projectDirectory: string;
let temporaryRoot: string;
let binaryDirectory: string;
let executablePath: string;
let service: JscpdService;
let executor: JscpdCommandExecutor;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-scan-test-"));
  projectDirectory = join(root, "project");
  temporaryRoot = join(root, "temporary");
  binaryDirectory = join(root, "bin");
  executablePath = join(binaryDirectory, "jscpd");
  await Promise.all([
    mkdir(join(projectDirectory, "src"), { recursive: true }),
    mkdir(join(projectDirectory, "lib"), { recursive: true }),
    mkdir(temporaryRoot),
    mkdir(binaryDirectory),
  ]);
  await Promise.all([
    writeFile(join(projectDirectory, "src/a.ts"), "synthetic fixture\n"),
    writeFile(join(projectDirectory, "lib/b.ts"), "synthetic fixture\n"),
    writeFile(join(projectDirectory, ".jscpd.json"), '{"threshold":10}\n'),
    ...["clean", "positive", "no-report", "malformed", "invalid", "fail", "timeout", "cancel"].map(
      (directory) => mkdir(join(projectDirectory, directory)),
    ),
  ]);
  const source = FAKE_JSCPD_SOURCE(process.execPath, await realpath(projectDirectory));
  await writeFile(executablePath, source, { mode: 0o700 });
  await chmod(executablePath, 0o700);

  service = createJscpdService({ temporaryRoot, timeoutMs: 500 });
  executor = createJscpdScanExecutor(createJscpdCapabilityService(), service, {
    path: binaryDirectory,
  });
});

afterEach(async () => {
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

function toolContext(signal?: AbortSignal): ExtensionContext {
  return { cwd: projectDirectory, signal } as unknown as ExtensionContext;
}

function commandContext(notify: ReturnType<typeof vi.fn>): ExtensionCommandContext {
  return {
    cwd: projectDirectory,
    signal: undefined,
    ui: { notify },
  } as unknown as ExtensionCommandContext;
}

async function fakeCalls(): Promise<FakeCall[]> {
  const text = await readFile(join(binaryDirectory, "calls.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeCall);
}

async function expectTemporaryReportsRemoved(): Promise<void> {
  await expect(readdir(temporaryRoot)).resolves.toEqual([]);
}

describe("end-to-end explicit scans", () => {
  it("runs project and path scans through both Pi surfaces with owned report arguments", async () => {
    const tool = createJscpdToolDefinition(executor);
    const toolResult = await tool.execute(
      "tool-call",
      { command: "scan" },
      undefined,
      undefined,
      toolContext(),
    );
    const notify = vi.fn();
    const slash = createJscpdSlashCommandDefinition(executor);

    await slash.handler('scan "src"', commandContext(notify));

    expect(toolResult.details).toMatchObject({
      status: "completed",
      outcome: "findings",
      summary: { clones: 1, duplicatedLines: 1, sources: 2 },
      findings: [
        {
          occurrences: [
            { path: "lib/b.ts", startLine: 1, endLine: 1 },
            { path: "src/a.ts", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /current location: lib\/b\.ts:1-1.*current location: src\/a\.ts:1-1/s,
      ),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/current location: lib\/b\.ts:1-1.*current location: src\/a\.ts:1-1/s),
      "info",
    );

    const calls = await fakeCalls();
    expect(calls).toHaveLength(2);
    expect(calls.every(({ config, cwd }) => config && cwd)).toBe(true);
    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ["--reporters", "json"],
      ["--reporters", "json"],
    ]);
    for (const { args } of calls) {
      expect(args[2]).toBe("--output");
      expect(resolve(args[3] ?? "").startsWith(await realpath(temporaryRoot))).toBe(true);
      expect(args[4]).toBe("--absolute");
      expect(args[5]).toBe("--");
      expect(args).not.toContain("--config");
      expect(args).not.toContain("--threshold");
    }
    expect(calls.map(({ args }) => args.slice(6))).toEqual([["."], ["src"]]);
    await expectTemporaryReportsRemoved();
  });

  it("returns a concise clean summary with authoritative scan statistics", async () => {
    const result = await dispatchJscpdCommand(
      "scan",
      ["clean"],
      { cwd: projectDirectory },
      executor,
    );

    expect(result).toEqual({
      status: "completed",
      outcome: "clean",
      message: "jscpd scan clean: 0 duplicate blocks across 0 lines and 0 tokens in 0 sources.",
      terminalMessage:
        "jscpd scan clean: 0 duplicate blocks across 0 lines and 0 tokens in 0 sources.",
      summary: {
        clones: 0,
        duplicatedLines: 0,
        duplicatedTokens: 0,
        lines: 0,
        percentage: 0,
        percentageTokens: 0,
        sources: 0,
        tokens: 0,
      },
      findings: [],
      omittedFindings: 0,
    });
    await expectTemporaryReportsRemoved();
  });

  it("accepts clone-positive exit 1 only with a validated findings report", async () => {
    await expect(
      dispatchJscpdCommand("scan", ["positive"], { cwd: projectDirectory }, executor),
    ).resolves.toMatchObject({ status: "completed", outcome: "findings" });
    await expectTemporaryReportsRemoved();
  });

  it("reports missing and incompatible executables before creating a report workspace", async () => {
    const emptyPath = join(root, "empty-bin");
    await mkdir(emptyPath);
    const missingExecutor = createJscpdScanExecutor(createJscpdCapabilityService(), service, {
      path: emptyPath,
    });
    const incompatibleExecutor = createJscpdScanExecutor(
      {
        async probe() {
          return {
            status: "incompatible",
            executable: "jscpd",
            version: "4.0.0",
            major: 4,
            supportedMajor: 5,
          };
        },
        invalidate() {},
        dispose() {},
      },
      service,
    );

    await expect(
      dispatchJscpdCommand("scan", [], { cwd: projectDirectory }, missingExecutor),
    ).resolves.toMatchObject({ status: "unavailable", reason: "missing-binary" });
    await expect(
      dispatchJscpdCommand("scan", [], { cwd: projectDirectory }, incompatibleExecutor),
    ).resolves.toMatchObject({ status: "unavailable", reason: "incompatible-version" });
    await expectTemporaryReportsRemoved();
  });

  it("stays dormant when trusted extension configuration disables scanning", async () => {
    const probe = vi.fn(async () => ({
      status: "available" as const,
      executable: "jscpd" as const,
      version: "5.1.1",
      major: 5 as const,
    }));
    const disabledExecutor = createJscpdScanExecutor(
      { probe, invalidate() {}, dispose() {} },
      service,
      {
        config: () => ({ enabled: false, timeoutMs: 30_000, maxFindings: 10 }),
      },
    );

    await expect(
      dispatchJscpdCommand("scan", [], { cwd: projectDirectory }, disabledExecutor),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "disabled",
      message: "jscpd scanning is disabled for this session. Run /jscpd on to re-enable it.",
    });
    expect(probe).not.toHaveBeenCalled();
    await expectTemporaryReportsRemoved();
  });

  it("surfaces cleanup uncertainty separately from scan process failures", async () => {
    const cleanupExecutor = createJscpdScanExecutor(
      {
        async probe() {
          return { status: "available", executable: "jscpd", version: "5.1.1", major: 5 };
        },
        invalidate() {},
        dispose() {},
      },
      {
        async run() {
          return { status: "failed", reason: "cleanup-failed" };
        },
        invalidate() {},
        async dispose() {},
      } as JscpdService,
    );

    await expect(
      dispatchJscpdCommand("scan", [], { cwd: projectDirectory }, cleanupExecutor),
    ).resolves.toEqual({
      status: "failed",
      reason: "cleanup-failed",
      message: "The jscpd scan ended, but temporary report cleanup could not be confirmed.",
    });
  });

  it.each([
    ["no-report", "missing-report"],
    ["malformed", "malformed-report"],
    ["invalid", "invalid-report"],
    ["fail", "process-failed"],
    ["timeout", "scan-timed-out"],
  ] as const)("fails open for %s with %s and cleans reports", async (target, reason) => {
    const result = await dispatchJscpdCommand(
      "scan",
      [target],
      { cwd: projectDirectory },
      executor,
    );

    expect(result).toMatchObject({ status: "failed", reason });
    expect(JSON.stringify(result)).not.toContain("private source");
    expect(JSON.stringify(result)).not.toContain(projectDirectory);
    await expectTemporaryReportsRemoved();
  });

  it("cancels an active scan without retaining child processes or reports", async () => {
    await dispatchJscpdCommand("scan", ["clean"], { cwd: projectDirectory }, executor);
    const controller = new AbortController();
    const active = dispatchJscpdCommand(
      "scan",
      ["cancel"],
      { cwd: projectDirectory, signal: controller.signal },
      executor,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    controller.abort();

    await expect(active).resolves.toMatchObject({ status: "failed", reason: "scan-cancelled" });
    await expectTemporaryReportsRemoved();
  });
});

describe("scan scope safety", () => {
  it("rejects traversal, missing paths, and symlink escapes without invoking jscpd", async () => {
    const outside = join(root, "outside.ts");
    await writeFile(outside, "synthetic outside fixture\n");
    await symlink(outside, join(projectDirectory, "escape.ts"));

    const traversal = await dispatchJscpdCommand(
      "scan",
      ["../outside.ts"],
      { cwd: projectDirectory },
      executor,
    );
    const escaped = await dispatchJscpdCommand(
      "scan",
      ["escape.ts"],
      { cwd: projectDirectory },
      executor,
    );
    const missing = await dispatchJscpdCommand(
      "scan",
      ["missing.ts"],
      { cwd: projectDirectory },
      executor,
    );

    expect(traversal).toMatchObject({ status: "failed", reason: "unsafe-path" });
    expect(escaped).toMatchObject({ status: "failed", reason: "unsafe-path" });
    expect(missing).toMatchObject({ status: "failed", reason: "unsupported-path" });
    expect(JSON.stringify([traversal, escaped, missing])).not.toContain(root);
    await expect(readFile(join(binaryDirectory, "calls.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectTemporaryReportsRemoved();
  });

  it("keeps option-looking file scopes behind the argument separator", async () => {
    await writeFile(join(projectDirectory, "--output"), "synthetic fixture\n");

    await expect(
      dispatchJscpdCommand("scan", ["--output"], { cwd: projectDirectory }, executor),
    ).resolves.toMatchObject({ status: "completed" });

    const [call] = await fakeCalls();
    expect(call?.args.slice(-2)).toEqual(["--", "--output"]);
    expect(call?.args.filter((token) => token === "--output")).toHaveLength(2);
    await expectTemporaryReportsRemoved();
  });
});
