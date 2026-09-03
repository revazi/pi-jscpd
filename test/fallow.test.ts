import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJscpdFallowCoexistenceService,
  evaluateJscpdFallowCoexistence,
} from "../src/fallow.js";

let root: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-fallow-test-"));
  project = join(root, "project");
  await mkdir(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function evaluate(
  overrides: Partial<Parameters<typeof evaluateJscpdFallowCoexistence>[0]> = {},
) {
  return evaluateJscpdFallowCoexistence({
    cwd: project,
    trusted: true,
    policy: "auto",
    fallowToolAvailable: false,
    ...overrides,
  });
}

describe("conservative Fallow overlap detection", () => {
  it("leaves automatic checks enabled when supported signals are absent", async () => {
    await expect(evaluate()).resolves.toEqual({
      status: "absent",
      policy: "auto",
      automaticAllowed: true,
      signals: [],
      statusText: "Fallow overlap: not detected",
    });
  });

  it("detects an active Pi Fallow tool with project evidence and emits one bounded choice notice", async () => {
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ devDependencies: { "pi-fallow": "0.5" } }),
    );
    const service = createJscpdFallowCoexistenceService();
    const state = await service.evaluate({
      cwd: project,
      trusted: true,
      policy: "auto",
      fallowToolAvailable: true,
    });

    expect(state).toMatchObject({
      status: "detected",
      automaticAllowed: false,
      signals: ["active-pi-fallow-tool", "fallow-dependency"],
    });
    expect(service.takeNotice()).toMatch(
      /automatic jscpd changed checks are on demand.*\/jscpd scan <target>.*‘allow’.*‘on-demand’/,
    );
    expect(service.takeNotice()).toBeUndefined();
  });

  it("treats an active Fallow tool without project-use evidence as ambiguous", async () => {
    await expect(evaluate({ fallowToolAvailable: true })).resolves.toMatchObject({
      status: "ambiguous",
      automaticAllowed: true,
      signals: ["active-pi-fallow-tool"],
    });
  });

  it.each([
    [
      ".fallowrc.json",
      JSON.stringify({ duplicates: { minTokens: 80 } }),
      "duplication-config-enabled",
    ],
    [
      "package.json",
      JSON.stringify({ scripts: { audit: "fallow audit --base main" } }),
      "duplication-script",
    ],
    [
      "package.json",
      JSON.stringify({ scripts: { dupes: "npx --yes fallow dupes --changed-since main" } }),
      "duplication-script",
    ],
  ] as const)("detects explicit duplication use from %s", async (name, contents, signal) => {
    await writeFile(join(project, name), contents);

    const state = await evaluate();

    expect(state.status).toBe("detected");
    expect(state.automaticAllowed).toBe(false);
    expect(state.signals).toContain(signal);
  });

  it("honors an explicit Fallow duplication disable over an active tool or script", async () => {
    await writeFile(
      join(project, ".fallowrc.json"),
      JSON.stringify({ duplicates: { enabled: false } }),
    );
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ scripts: { dupes: "fallow dupes" }, devDependencies: { fallow: "3" } }),
    );

    const state = await evaluate({ fallowToolAvailable: true });

    expect(state).toMatchObject({
      status: "absent",
      automaticAllowed: true,
    });
    expect(state.signals).toEqual([
      "active-pi-fallow-tool",
      "duplication-config-disabled",
      "duplication-script",
      "fallow-dependency",
    ]);
  });

  it.each([
    ["package.json", JSON.stringify({ devDependencies: { fallow: "3" } }), "fallow-dependency"],
    [".fallowrc.json", JSON.stringify({ health: { maxCyclomatic: 10 } }), "fallow-config-present"],
    [".fallowrc.json", "{ malformed", "unreadable-signal"],
    [".fallowrc.jsonc", "{ /* comments */ }", "unreadable-signal"],
    ["fallow.toml", "[duplicates]\nenabled = false", "unreadable-signal"],
  ] as const)("treats unsupported or non-duplication evidence in %s as ambiguous", async (name, contents, signal) => {
    await writeFile(join(project, name), contents);

    const state = await evaluate();

    expect(state.status).toBe("ambiguous");
    expect(state.automaticAllowed).toBe(true);
    expect(state.notice).toBeUndefined();
    expect(state.signals).toContain(signal);
  });

  it("treats oversized signal files as ambiguous and never reads them as policy", async () => {
    await writeFile(join(project, ".fallowrc.json"), "x".repeat(64 * 1024 + 1));

    const state = await evaluate();

    expect(state).toMatchObject({ status: "ambiguous", automaticAllowed: true });
    expect(state.signals).toContain("unreadable-signal");
  });

  it("does not treat prose mentioning a Fallow command as an executable script", async () => {
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ scripts: { note: "echo fallow dupes" } }),
    );

    await expect(evaluate()).resolves.toMatchObject({
      status: "absent",
      automaticAllowed: true,
    });
  });

  it("does not inspect untrusted project files and does not suppress on uncertainty", async () => {
    await writeFile(join(project, "package.json"), "{ private malformed content");

    const state = await evaluate({ trusted: false });

    expect(state).toMatchObject({
      status: "ambiguous",
      automaticAllowed: true,
      signals: [],
    });
    expect(JSON.stringify(state)).not.toContain("private malformed content");
  });

  it("treats unsafe signal-file symlinks as ambiguous without exposing their target", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ duplicates: { enabled: true } }));
    await symlink(outside, join(project, ".fallowrc.json"));

    const state = await evaluate();

    expect(state).toMatchObject({ status: "ambiguous", automaticAllowed: true });
    expect(state.signals).toContain("unreadable-signal");
    expect(JSON.stringify(state)).not.toContain(root);
  });

  it("supports explicit on-demand and allow coexistence without project inspection", async () => {
    await writeFile(join(project, "package.json"), "{ malformed");

    await expect(evaluate({ policy: "on-demand", fallowToolAvailable: true })).resolves.toEqual({
      status: "explicit-on-demand",
      policy: "on-demand",
      automaticAllowed: false,
      signals: [],
      statusText: "Fallow coexistence: jscpd automatic checks explicitly on demand",
    });
    await expect(evaluate({ policy: "allow", fallowToolAvailable: true })).resolves.toEqual({
      status: "explicit-allow",
      policy: "allow",
      automaticAllowed: true,
      signals: [],
      statusText: "Fallow coexistence: both automatic analyzers explicitly allowed",
    });
  });
});
