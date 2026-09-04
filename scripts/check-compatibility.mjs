import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readJson(join(projectRoot, "package.json"));
const expectedNodeRange = ">=22.19.0 <23 || >=24 <25";
const expectedPiVersion = "0.84.4";
const expectedEffectVersion = "3.22.1";
const expectedEffectIntegrity =
  "sha512-TNoXushmPOBAjJlthF5d2QwnX2xBPEtcNJr5XKNKbRLbDvBcOYkXlYDfvGfSA0zriwLFuCll5MDtNMAdZL17PQ==";
const expectedJscpdVersion = "5.1.2";
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

if (manifest.dependencies?.effect !== expectedEffectVersion) {
  fail(`The Effect runtime dependency must remain pinned at ${expectedEffectVersion}.`);
}
const installedEffect = await readJson(join(projectRoot, "node_modules", "effect", "package.json"));
if (installedEffect.version !== expectedEffectVersion || installedEffect.license !== "MIT") {
  fail(
    `Installed Effect ${installedEffect.version} (${installedEffect.license}) does not match the reviewed ${expectedEffectVersion} MIT runtime.`,
  );
}
const lock = await readJson(join(projectRoot, "package-lock.json"));
const lockedEffect = lock.packages?.["node_modules/effect"];
if (
  lock.packages?.[""]?.dependencies?.effect !== expectedEffectVersion ||
  lockedEffect?.version !== expectedEffectVersion ||
  lockedEffect?.integrity !== expectedEffectIntegrity
) {
  fail(`package-lock.json does not preserve reviewed Effect ${expectedEffectVersion} integrity.`);
}

if (manifest.dependencies?.jscpd !== expectedJscpdVersion) {
  fail(`The bundled jscpd dependency must remain pinned at ${expectedJscpdVersion}.`);
}
const installedJscpd = await readJson(join(projectRoot, "node_modules", "jscpd", "package.json"));
if (installedJscpd.version !== expectedJscpdVersion) {
  fail(
    `Installed jscpd ${installedJscpd.version} does not match the ${expectedJscpdVersion} runtime dependency.`,
  );
}

console.log(
  `Compatibility check passed: Node ${process.versions.node}, Pi ${expectedPiVersion}, TypeBox ${manifest.devDependencies.typebox}, Effect ${expectedEffectVersion}, jscpd ${expectedJscpdVersion}.`,
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
