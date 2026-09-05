import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = readJson("package.json");
const trackedFiles = gitPaths(["ls-files", "-z"]);
const visibleUntrackedFiles = gitPaths(["ls-files", "-z", "--others", "--exclude-standard"]);
const candidateFiles = new Set([...trackedFiles, ...visibleUntrackedFiles]);
const workingTreePaths = statusPaths();
const requiredPublicFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/release-readiness.yml",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/compatibility.md",
  "docs/effect-architecture.md",
  "docs/release.md",
];
const forbiddenPathPatterns = [
  /(^|\/)\.agents(?:\/|$)/i,
  /(^|\/)AGENTS\.md$/i,
  /^work\//i,
  /^outputs?\//i,
  /^reports?\//i,
  /(^|\/)node_modules(?:\/|$)/i,
  /^coverage(?:\/|$)/i,
  /^dist(?:\/|$)/i,
  /(^|\/)\.pi\/.*\.local\.json$/i,
  /(^|\/)\.env(?:\..*)?$/i,
  /(^|\/)[^/]*(?:credentials?|secrets?)(?:[._-][^/]*)?$/i,
  /\.tgz$/i,
  /\.log$/i,
];

for (const path of requiredPublicFiles) {
  assert.ok(candidateFiles.has(path), `Required public repository file is missing: ${path}.`);
}
assert.deepEqual(
  trackedFiles.filter(isForbiddenPath),
  [],
  "Git tracks a private, generated, credential, report, or local-only path.",
);
assert.deepEqual(
  workingTreePaths.filter(isForbiddenPath),
  [],
  "The visible working tree contains an unignored private or generated artifact.",
);

const requiredIgnores = [
  "node_modules/",
  "coverage/",
  "dist/",
  "/work/",
  "/outputs/",
  "*.tgz",
  "*.log",
  "/reports/",
  "/tmp/",
  "/.npmrc",
  "/.env",
  "/.env.*",
  "*.pem",
  "*.key",
  "/.agents/",
  "/AGENTS.md",
  ".pi/jscpd-guardrail.local.json",
  ".jscpd-session/",
];
const ignoreLines = new Set(readText(".gitignore").split(/\r?\n/));
for (const pattern of requiredIgnores) {
  assert.ok(ignoreLines.has(pattern), `.gitignore is missing the required rule: ${pattern}.`);
}

assert.equal(manifest.name, "pi-jscpd");
assert.equal(manifest.version, "0.0.0", "Release preparation must not choose a version.");
assert.equal(manifest.private, true, "Release preparation must keep the package private.");
assert.deepEqual(manifest.publishConfig, { access: "public", provenance: true });
assert.deepEqual(manifest.files, [
  "src",
  "docs",
  "scripts/check-compatibility.mjs",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "README.md",
  "LICENSE",
]);
for (const lifecycleScript of [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]) {
  assert.equal(
    manifest.scripts?.[lifecycleScript],
    undefined,
    `Unexpected npm lifecycle script: ${lifecycleScript}.`,
  );
}

const readinessWorkflow = readText(".github/workflows/release-readiness.yml");
assert.match(readinessWorkflow, /^name: Release readiness \(no publish\)$/m);
assert.match(readinessWorkflow, /^on:\n {2}workflow_dispatch:/m);
assert.match(readinessWorkflow, /^permissions: \{\}$/m);
assert.doesNotMatch(readinessWorkflow, /^\s+(?:push|pull_request|release|workflow_run|schedule):/m);
for (const forbidden of [
  /\bnpm\s+publish\b/i,
  /\bgh\s+release\b/i,
  /\bgit\s+tag\b/i,
  /\bid-token:\s*write\b/i,
  /\bcontents:\s*write\b/i,
  /\bpackages:\s*write\b/i,
  /\bsecrets\./i,
  /\bNODE_AUTH_TOKEN\b/,
  /\bNPM_TOKEN\b/,
]) {
  assert.doesNotMatch(readinessWorkflow, forbidden, `Release-readiness workflow is privileged.`);
}
assert.match(readinessWorkflow, /run: npm run release:check/);

console.log(
  `Repository hygiene passed: ${trackedFiles.length} tracked files, ${workingTreePaths.length} visible working-tree paths, private release guard active.`,
);

function gitPaths(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

function statusPaths() {
  const entries = gitPaths(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const state = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (state.includes("R") || state.includes("C")) {
      index += 1;
      paths.push(entries[index]);
    }
  }
  return paths;
}

function isForbiddenPath(path) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(path.replaceAll("\\", "/")));
}

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}
