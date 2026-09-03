import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readJson(join(projectRoot, "package.json"));
const expectedNodeRange = ">=22.19.0 <23 || >=24 <25";
const expectedPiVersion = "0.84.4";
const expectedPeerRanges = Object.freeze({
  "@earendil-works/pi-ai": ">=0.84.4 <0.85.0",
  "@earendil-works/pi-coding-agent": ">=0.84.4 <0.85.0",
  "@earendil-works/pi-tui": ">=0.84.4 <0.85.0",
  typebox: ">=1.3.7 <2",
});

if (manifest.engines?.node !== expectedNodeRange) {
  fail(`The Node engine range must remain ${expectedNodeRange}.`);
}
if (!supportsNode(process.versions.node)) {
  fail(`Node ${process.versions.node} is outside the supported Node 22.19+ and Node 24 ranges.`);
}

for (const [name, range] of Object.entries(expectedPeerRanges)) {
  if (manifest.peerDependencies?.[name] !== range) {
    fail(`The ${name} peer range must remain ${range}.`);
  }
  const installed = await readJson(
    join(projectRoot, "node_modules", ...name.split("/"), "package.json"),
  );
  const pinned = manifest.devDependencies?.[name];
  if (typeof pinned !== "string" || pinned === "" || /[<>=*^~| ]/.test(pinned)) {
    fail(`The development fixture for ${name} must be an exact version.`);
  }
  if (installed.version !== pinned) {
    fail(
      `Installed ${name} ${installed.version} does not match the ${pinned} development fixture.`,
    );
  }
}

for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]) {
  if (manifest.devDependencies?.[name] !== expectedPiVersion) {
    fail(`The tested Pi package set must remain aligned at ${expectedPiVersion}.`);
  }
}

console.log(
  `Compatibility check passed: Node ${process.versions.node}, Pi ${expectedPiVersion}, TypeBox ${manifest.devDependencies.typebox}.`,
);

function supportsNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 24 || (major === 22 && minor >= 19);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function fail(message) {
  console.error(`Compatibility check failed: ${message}`);
  process.exit(1);
}
