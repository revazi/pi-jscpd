import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicMarkdown = Object.freeze(
  [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ".github/pull_request_template.md",
    ...readdirSync(join(root, "docs"))
      .filter((name) => extname(name).toLowerCase() === ".md")
      .map((name) => `docs/${name}`),
  ].sort(),
);

const failures = [];
for (const path of publicMarkdown) checkMarkdown(path);

if (failures.length > 0) {
  console.error(`Markdown check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`Markdown check passed: ${publicMarkdown.length} public files and their local links.`);

function checkMarkdown(path) {
  const absolutePath = join(root, path);
  const markdown = readFileSync(absolutePath, "utf8");
  const links = [
    ...markdown.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
    ...markdown.matchAll(/^\s*\[[^\]]+\]:\s+(\S+)/gm),
  ];
  for (const match of links) checkLink(path, markdown, match[1], lineNumber(markdown, match.index));
}

function checkLink(sourcePath, sourceMarkdown, rawTarget, line) {
  const target = stripAngleBrackets(rawTarget);
  if (isIgnoredTarget(target)) return;
  if (/^https?:\/\//i.test(target)) {
    checkExternalLink(sourcePath, target, line);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    failures.push(`${sourcePath}:${line} uses an unsupported link scheme: ${target}`);
    return;
  }
  checkLocalLink(sourcePath, sourceMarkdown, target, line);
}

function checkExternalLink(sourcePath, target, line) {
  try {
    new URL(target);
  } catch {
    failures.push(`${sourcePath}:${line} has an invalid external URL: ${target}`);
  }
}

function checkLocalLink(sourcePath, sourceMarkdown, target, line) {
  const decoded = decodeLocalTarget(sourcePath, target, line);
  if (!decoded) return;
  const absoluteTarget = resolveLocalTarget(sourcePath, decoded.path, target, line);
  if (!absoluteTarget) return;
  if (!validateLocalFile(sourcePath, absoluteTarget, target, line)) return;
  checkLocalAnchor(sourcePath, sourceMarkdown, absoluteTarget, decoded, target, line);
}

function decodeLocalTarget(sourcePath, target, line) {
  const [rawPath, rawFragment = ""] = target.split("#", 2);
  try {
    return { path: decodeURIComponent(rawPath), fragment: decodeURIComponent(rawFragment) };
  } catch {
    failures.push(`${sourcePath}:${line} has invalid URL encoding: ${target}`);
    return undefined;
  }
}

function resolveLocalTarget(sourcePath, decodedPath, target, line) {
  const targetPath = decodedPath === "" ? sourcePath : join(dirname(sourcePath), decodedPath);
  const absoluteTarget = resolve(root, targetPath);
  const repositoryRelativeTarget = relative(root, absoluteTarget);
  if (repositoryRelativeTarget.startsWith("..") || isAbsolute(repositoryRelativeTarget)) {
    failures.push(`${sourcePath}:${line} escapes the repository: ${target}`);
    return undefined;
  }
  return absoluteTarget;
}

function validateLocalFile(sourcePath, absoluteTarget, target, line) {
  if (!existsSync(absoluteTarget)) {
    failures.push(`${sourcePath}:${line} points to a missing local target: ${target}`);
    return false;
  }
  if (!statSync(absoluteTarget).isFile()) {
    failures.push(`${sourcePath}:${line} local target is not a file: ${target}`);
    return false;
  }
  return true;
}

function checkLocalAnchor(sourcePath, sourceMarkdown, absoluteTarget, decoded, target, line) {
  if (decoded.fragment === "") return;
  if (extname(absoluteTarget).toLowerCase() !== ".md") {
    failures.push(`${sourcePath}:${line} adds an anchor to a non-Markdown file: ${target}`);
    return;
  }
  const targetMarkdown = linkedMarkdown(sourceMarkdown, absoluteTarget, decoded.path);
  if (!markdownAnchors(targetMarkdown).has(decoded.fragment.toLowerCase())) {
    failures.push(`${sourcePath}:${line} points to a missing Markdown anchor: ${target}`);
  }
}

function linkedMarkdown(sourceMarkdown, absoluteTarget, decodedPath) {
  return decodedPath === "" ? sourceMarkdown : readFileSync(absoluteTarget, "utf8");
}

function markdownAnchors(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const match of markdown.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    addMarkdownAnchor(anchors, occurrences, githubAnchor(match[1]));
  }
  return anchors;
}

function addMarkdownAnchor(anchors, occurrences, base) {
  if (base === "") return;
  const count = occurrences.get(base) ?? 0;
  occurrences.set(base, count + 1);
  anchors.add(count === 0 ? base : `${base}-${count}`);
}

function githubAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function stripAngleBrackets(target) {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function isIgnoredTarget(target) {
  return target === "" || target.startsWith("mailto:");
}

function lineNumber(value, index = 0) {
  assert.ok(index >= 0);
  return value.slice(0, index).split("\n").length;
}
