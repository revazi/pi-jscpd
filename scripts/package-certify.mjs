import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedPackageFiles = Object.freeze(
  [
    ...trackedFiles("src", "docs"),
    "scripts/check-compatibility.mjs",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
  ].sort(),
);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await certifyPackage();
}

export async function certifyPackage() {
  const workspace = mkdtempSync(join(tmpdir(), "pi-jscpd-package-certification-"));
  const packDirectory = join(workspace, "pack");
  const installDirectory = join(workspace, "project");
  const fakeBinDirectory = join(workspace, "bin");
  const cleanupPids = [];

  try {
    const packed = packPackage(packDirectory);
    validatePackedArtifact(packed);
    const tarball = join(packDirectory, packed.filename);
    installTarball(tarball, installDirectory);
    const packageRoot = validateInstalledPackage(installDirectory);
    const host = resolveLockedPiHost();
    const fake = createFakeJscpd(fakeBinDirectory, workspace);

    await validateRpcRuntime(packageRoot, installDirectory, host, fake, join(workspace, "rpc"));
    await validateToolAndTuiContract(
      packageRoot,
      installDirectory,
      host,
      fake,
      join(workspace, "probe"),
    );
    validateNonInteractiveModes(
      packageRoot,
      installDirectory,
      host,
      fake,
      join(workspace, "non-interactive"),
    );
    await validateShutdownCleanup(
      packageRoot,
      installDirectory,
      host,
      fake,
      join(workspace, "shutdown"),
      cleanupPids,
    );

    console.log(
      `Package certification passed (${packed.filename}, ${packed.files.length} files, Pi ${host.version}; RPC/tool/TUI-contract/JSON/print and shutdown cleanup).`,
    );
  } finally {
    for (const pid of cleanupPids) terminateProcess(pid);
    rmSync(workspace, { recursive: true, force: true });
  }
}

function trackedFiles(...paths) {
  const output = execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

function packPackage(destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const output = execFileSync(
    npmExecutable,
    ["pack", "--json", "--pack-destination", destination],
    { cwd: root, encoding: "utf8" },
  );
  const results = JSON.parse(output);
  assert.equal(results.length, 1, "npm pack must produce exactly one artifact.");
  const packed = results[0];
  assert.equal(packed.name, "pi-jscpd");
  assert.equal(packed.version, "0.0.0");
  assert.equal(packed.id, "pi-jscpd@0.0.0");
  assert.match(packed.filename, /^pi-jscpd-0\.0\.0\.tgz$/);
  assert.ok(Array.isArray(packed.files), "npm pack did not report its file list.");
  assert.ok(existsSync(join(destination, packed.filename)), "npm pack did not create its tarball.");
  return packed;
}

export function validatePackedArtifact(packed) {
  const files = packed.files.map((file) => file.path).sort();
  assert.deepEqual(
    files,
    expectedPackageFiles,
    "Tarball contents differ from the tracked runtime/public-document allowlist.",
  );
  assert.equal(new Set(files).size, files.length, "Tarball contains duplicate paths.");

  for (const file of packed.files) {
    assert.equal(file.mode, 0o644, `Tarball file has an unsafe mode: ${file.path}.`);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, `Invalid size for ${file.path}.`);
    assert.equal(file.path.startsWith("/"), false, `Tarball path is absolute: ${file.path}.`);
    assert.equal(
      file.path.split("/").includes(".."),
      false,
      `Tarball path escapes its package root: ${file.path}.`,
    );
  }

  const privatePath =
    /(^|\/)(?:\.agents|\.github|\.pi|node_modules|test|work|outputs?|reports?)(?:\/|$)|(^|\/)(?:AGENTS\.md|\.env(?:\..*)?|[^/]*(?:credential|secret)[^/]*)$/i;
  assert.deepEqual(
    files.filter((path) => privatePath.test(path)),
    [],
    "Tarball contains a private, development-only, report, output, or credential path.",
  );
}

function installTarball(tarball, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "pi-jscpd-certification-project", private: true })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  execFileSync(
    npmExecutable,
    [
      "install",
      "--no-save",
      "--package-lock=false",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: directory, encoding: "utf8", stdio: "pipe" },
  );
}

function validateInstalledPackage(projectDirectory) {
  const packageRoot = join(projectDirectory, "node_modules", "pi-jscpd");
  const manifest = readJson(join(packageRoot, "package.json"));
  assert.equal(manifest.name, "pi-jscpd");
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.private, true, "Certification must not remove the release guard.");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.equal(manifest.dependencies, undefined, "The package must not own runtime dependencies.");
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-ai": ">=0.84.4 <0.85.0",
    "@earendil-works/pi-coding-agent": ">=0.84.4 <0.85.0",
    "@earendil-works/pi-tui": ">=0.84.4 <0.85.0",
    typebox: ">=1.3.7 <2",
  });

  const installedFiles = listFiles(packageRoot);
  assert.deepEqual(
    installedFiles,
    expectedPackageFiles,
    "Installed artifact differs from the pack list.",
  );
  for (const path of installedFiles) {
    const metadata = lstatSync(join(packageRoot, path));
    assert.equal(
      metadata.isFile(),
      true,
      `Installed package entry is not a regular file: ${path}.`,
    );
    assert.equal(
      metadata.isSymbolicLink(),
      false,
      `Installed package contains a symlink: ${path}.`,
    );
  }
  return packageRoot;
}

export function resolveLockedPiHost() {
  const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifest = readJson(join(packageRoot, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  const expectedVersion = lock.packages["node_modules/@earendil-works/pi-coding-agent"].version;
  assert.equal(
    manifest.version,
    expectedVersion,
    "Installed Pi fixture differs from package-lock.json.",
  );
  assert.equal(
    manifest.version,
    "0.84.4",
    "Package certification must use the certified Pi fixture.",
  );
  const cliEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  assert.equal(cliEntry, "dist/bundle/cli.js", "The certified Pi CLI entrypoint changed.");
  const cliPath = resolve(packageRoot, cliEntry);
  assert.ok(existsSync(cliPath), `Locked Pi CLI entrypoint is missing: ${cliEntry}.`);
  const version = execFileSync(process.execPath, [cliPath, "--version"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(version, expectedVersion, "Pi CLI version differs from the locked fixture.");
  return { cliPath, packageRoot, version };
}

async function validateRpcRuntime(packageRoot, projectDirectory, host, fake, runRoot) {
  const events = [];
  const rpc = createRpcClient(packageRoot, projectDirectory, host.cliPath, fake, runRoot);
  await withRpc(rpc, events, async () => {
    const commands = await rpc.getCommands();
    const jscpdCommands = commands.filter(
      (command) => command.name === "jscpd" && command.source === "extension",
    );
    assert.equal(jscpdCommands.length, 1, "Installed /jscpd was not discovered exactly once.");
    assert.equal(
      jscpdCommands[0].description,
      "Open the jscpd overview or run an explicit subcommand.",
    );

    await rpc.prompt("/jscpd help");
    await rpc.prompt("/jscpd status");
    assertProviderFree(events, "RPC slash commands");
  });
  assert.equal(
    rpc.getStderr(),
    "",
    `Installed extension wrote RPC diagnostics:\n${rpc.getStderr()}`,
  );
  await assertNoReportDirectories(join(runRoot, "tmp"));
}

async function validateToolAndTuiContract(packageRoot, projectDirectory, host, fake, runRoot) {
  const marker = join(runRoot, "probe-result.json");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const probe = join(runRoot, "artifact-probe.ts");
  writeFileSync(probe, probeExtensionSource(packageRoot, marker), { mode: 0o600 });
  const events = [];
  const rpc = createRpcClient(probe, projectDirectory, host.cliPath, fake, runRoot);
  await withRpc(rpc, events, async () => {
    const commands = await rpc.getCommands();
    assert.equal(
      commands.filter((command) => command.name === "jscpd").length,
      1,
      "Probe-loaded artifact did not register /jscpd exactly once.",
    );
    await rpc.prompt("/jscpd-certify-artifact");
    await waitFor(() => existsSync(marker), "artifact tool/TUI probe result");
  });
  assert.equal(rpc.getStderr(), "", `Artifact probe wrote Pi diagnostics:\n${rpc.getStderr()}`);
  assertProviderFree(events, "tool and TUI-compatible probe");

  const result = readJson(marker);
  assert.deepEqual(result.registeredTools, ["jscpd_run"]);
  assert.equal(result.toolName, "jscpd_run");
  assert.equal(result.toolLabel, "jscpd");
  assert.equal(result.commandRequired, true);
  assert.deepEqual(result.commands, ["scan", "changed", "status", "off", "on", "help"]);
  assert.equal(result.executionStatus, "status");
  assert.match(result.executionText, /jscpd status/i);
  assert.equal(result.tuiLineCount > 0, true);
  assert.match(result.tuiText, /jscpd/i);
  assert.equal(result.tuiMaxWidth <= 80, true);
  await assertNoReportDirectories(join(runRoot, "tmp"));
}

function validateNonInteractiveModes(packageRoot, projectDirectory, host, fake, runRoot) {
  const common = isolatedPiArguments(packageRoot);
  const print = runIsolatedPi(
    host.cliPath,
    ["--print", ...common, "/jscpd help"],
    fake,
    projectDirectory,
    join(runRoot, "print"),
  );
  assert.equal(print.status, 0, `Pi print-mode /jscpd help failed:\n${print.stderr}`);
  assert.equal(print.stdout, "");
  assert.equal(print.stderr, "");

  const json = runIsolatedPi(
    host.cliPath,
    ["--mode", "json", ...common, "/jscpd status"],
    fake,
    projectDirectory,
    join(runRoot, "json"),
  );
  assert.equal(json.status, 0, `Pi JSON-mode /jscpd status failed:\n${json.stderr}`);
  assert.equal(json.stderr, "");
  const events = json.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    events.some((event) => event.type === "session"),
    true,
  );
  assertProviderFree(events, "JSON-mode slash command");

  const fallback = runIsolatedPi(
    host.cliPath,
    ["--print", ...common, "/jscpd"],
    fake,
    projectDirectory,
    join(runRoot, "fallback"),
  );
  assert.equal(fallback.status, 0, `Pi print-mode /jscpd fallback failed:\n${fallback.stderr}`);
  assert.equal(fallback.stdout, "");
  assert.match(fallback.stderr, /^The \/jscpd overlay requires Pi TUI mode\./);
  assert.match(fallback.stderr, /jscpd status/);
  assert.doesNotMatch(fallback.stderr, /failed to load extension|extension error/i);
}

async function validateShutdownCleanup(
  packageRoot,
  projectDirectory,
  host,
  fake,
  runRoot,
  cleanupPids,
) {
  const hangFlag = join(runRoot, "hang");
  const processMarker = join(runRoot, "processes.json");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const rpc = createRpcClient(packageRoot, projectDirectory, host.cliPath, fake, runRoot, {
    JSCPD_CERTIFY_HANG_FLAG: hangFlag,
    JSCPD_CERTIFY_PROCESS_MARKER: processMarker,
  });
  const completedScans = countOccurrences(readIfPresent(fake.scanLog), "clean\n");
  try {
    await rpc.start();
    await waitFor(
      () => countOccurrences(readIfPresent(fake.scanLog), "clean\n") > completedScans,
      "initial packaged baseline scan",
    );
    writeFileSync(hangFlag, "hang\n", { mode: 0o600 });
    sendUntrackedRpcPrompt(rpc, "/jscpd scan");
    await waitFor(() => existsSync(processMarker), "active fake jscpd process tree");
    const marker = readJson(processMarker);
    cleanupPids.push(...[marker.parent, marker.child].filter(Number.isSafeInteger));
    assert.equal(cleanupPids.length, 2, "Fake jscpd did not create the expected process tree.");
    for (const pid of cleanupPids)
      assert.equal(processIsRunning(pid), true, `Process ${pid} did not start.`);
  } finally {
    await rpc.stop();
  }

  await waitFor(
    () => cleanupPids.every((pid) => !processIsRunning(pid)),
    "packaged jscpd process-tree shutdown",
    5_000,
  );
  await assertNoReportDirectories(join(runRoot, "tmp"));
  assert.doesNotMatch(rpc.getStderr(), /failed to load extension|extension error/i);
}

async function withRpc(rpc, events, operation) {
  const unsubscribe = rpc.onEvent((event) => events.push(event));
  try {
    await rpc.start();
    await operation();
  } finally {
    unsubscribe();
    await rpc.stop();
  }
}

function createRpcClient(
  extensionPath,
  projectDirectory,
  cliPath,
  fake,
  runRoot,
  extraEnvironment = {},
) {
  const environment = isolatedEnvironment(runRoot, fake, extraEnvironment);
  return new RpcClient({
    cliPath,
    cwd: projectDirectory,
    env: environment,
    args: isolatedPiArguments(extensionPath),
  });
}

export function isolatedPiArguments(extensionPath) {
  return [
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--tools",
    "jscpd_run",
    "--no-approve",
    "-e",
    extensionPath,
  ];
}

function runIsolatedPi(cliPath, args, fake, projectDirectory, runRoot) {
  // fallow-ignore-next-line security-sink -- process.execPath launches the locked, validated local Pi CLI without a shell.
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDirectory,
    env: isolatedEnvironment(runRoot, fake),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `Pi process failed: ${result.error}`);
  assert.equal(result.signal, null, `Pi process exited from ${result.signal}.`);
  assertNoReportDirectoriesSync(join(runRoot, "tmp"));
  return result;
}

export function isolatedEnvironment(runRoot, fake, extra = {}) {
  const home = join(runRoot, "home");
  const agent = join(runRoot, "agent");
  const temporary = join(runRoot, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const environment = {
    PATH: `${fake.binDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    CI: "1",
    NO_COLOR: "1",
    JSCPD_CERTIFY_SCAN_LOG: fake.scanLog,
    ...extra,
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function createFakeJscpd(binDirectory, workspace) {
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const executable = join(binDirectory, "jscpd");
  const scanLog = join(workspace, "fake-jscpd-scans.log");
  writeFileSync(executable, fakeJscpdSource(), { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { binDirectory, scanLog };
}

function fakeJscpdSource() {
  const cleanReport = JSON.stringify({
    duplicates: [],
    statistics: {
      detectionDate: "2026-09-03T00:00:00.000Z",
      formats: {},
      total: {
        clones: 0,
        duplicatedLines: 0,
        duplicatedTokens: 0,
        lines: 0,
        newClones: 0,
        newDuplicatedLines: 0,
        percentage: 0,
        percentageTokens: 0,
        sources: 0,
        tokens: 0,
      },
    },
  });
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("jscpd 5.1.0\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(9);
const output = args[outputIndex + 1];
if (process.env.JSCPD_CERTIFY_HANG_FLAG && existsSync(process.env.JSCPD_CERTIFY_HANG_FLAG)) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(process.env.JSCPD_CERTIFY_PROCESS_MARKER, JSON.stringify({ parent: process.pid, child: child.pid }));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "jscpd-report.json"), ${JSON.stringify(cleanReport)});
  appendFileSync(process.env.JSCPD_CERTIFY_SCAN_LOG, "clean\\n");
}
`;
}

function probeExtensionSource(packageRoot, marker) {
  const entry = pathToFileURL(join(packageRoot, "src", "index.ts")).href;
  const overlay = pathToFileURL(join(packageRoot, "src", "overlay.ts")).href;
  return `import { writeFile } from "node:fs/promises";
import extension from ${JSON.stringify(entry)};
import { JscpdOverlayComponent } from ${JSON.stringify(overlay)};

export default async function (pi) {
  let captured;
  const registerTool = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => {
    captured = tool;
    registerTool(tool);
  };
  await extension(pi);
  if (!captured) throw new Error("jscpd_run was not registered");
  pi.registerCommand("jscpd-certify-artifact", {
    description: "Private package certification probe",
    async handler(_args, ctx) {
      const execution = await captured.execute(
        "package-certification",
        { command: "status", args: [] },
        ctx.signal,
        () => {},
        ctx,
      );
      const status = execution.details;
      const tui = { terminal: { rows: 24 }, requestRender() {} };
      const theme = { fg(_color, text) { return text; } };
      const keys = { matches() { return false; } };
      const component = new JscpdOverlayComponent({
        tui,
        theme,
        keybindings: keys,
        executor: { async execute() { return status; } },
        cwd: ctx.cwd,
        signal: ctx.signal,
        changedFileCount: () => 0,
        done() {},
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const lines = component.render(80);
      component.dispose();
      const schema = captured.parameters;
      const commandSchema = schema.properties?.command;
      const commands = commandSchema?.enum ?? [];
      await writeFile(${JSON.stringify(marker)}, JSON.stringify({
        registeredTools: pi.getAllTools().filter((tool) => tool.name === "jscpd_run").map((tool) => tool.name),
        toolName: captured.name,
        toolLabel: captured.label,
        commandRequired: schema.required?.includes("command") ?? false,
        commands,
        executionStatus: status.status,
        executionText: execution.content?.[0]?.text ?? "",
        tuiLineCount: lines.length,
        tuiText: lines.join("\\n"),
        tuiMaxWidth: Math.max(...lines.map((line) => line.length)),
      }));
    },
  });
}
`;
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(directory, path));
    else files.push(path);
  }
  return files.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function assertProviderFree(events, label) {
  const forbidden = events.filter((event) =>
    ["extension_error", "agent_start", "turn_start"].includes(event.type),
  );
  assert.deepEqual(forbidden, [], `${label} emitted an extension error or provider turn.`);
}

async function assertNoReportDirectories(temporaryRoot) {
  await waitFor(
    () => reportDirectories(temporaryRoot).length === 0,
    "temporary jscpd report cleanup",
    5_000,
  );
}

function assertNoReportDirectoriesSync(temporaryRoot) {
  assert.deepEqual(
    reportDirectories(temporaryRoot),
    [],
    "Pi shutdown left a temporary jscpd report directory behind.",
  );
}

function reportDirectories(temporaryRoot) {
  if (!existsSync(temporaryRoot)) return [];
  return readdirSync(temporaryRoot).filter((entry) => entry.startsWith("pi-jscpd-"));
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

function sendUntrackedRpcPrompt(rpc, message) {
  const input = rpc.process?.stdin;
  assert.ok(input?.writable, "Pi RPC input is not writable for the shutdown probe.");
  input.write(`${JSON.stringify({ type: "prompt", id: "package-shutdown", message })}\n`);
}

function countOccurrences(value, fragment) {
  return value.split(fragment).length - 1;
}

export function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function terminateProcess(pid) {
  if (!Number.isSafeInteger(pid) || !processIsRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
