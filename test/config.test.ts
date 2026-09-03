import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJscpdConfigService, DEFAULT_JSCPD_CONFIG } from "../src/config.js";

let root: string;
let projectDirectory: string;
let configDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-config-test-"));
  projectDirectory = join(root, "project");
  configDirectory = join(projectDirectory, CONFIG_DIR_NAME);
  await mkdir(configDirectory, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(
  name: "jscpd-guardrail.json" | "jscpd-guardrail.local.json",
  value: unknown,
): Promise<void> {
  const contents = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(join(configDirectory, name), contents);
}

describe("trusted extension configuration", () => {
  it("uses immutable zero-config defaults when trusted files are missing", async () => {
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: true });

    expect(result).toEqual({
      config: {
        enabled: true,
        timeoutMs: 30_000,
        maxFindings: 10,
        fallowCoexistence: "auto",
      },
      sources: ["defaults"],
      diagnostics: [],
      trusted: true,
    });
    expect(service.current()).toBe(result);
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  it("merges defaults, project settings, and higher-precedence local overrides", async () => {
    await writeConfig("jscpd-guardrail.json", {
      enabled: false,
      timeoutMs: 45_000,
      maxFindings: 20,
      fallowCoexistence: "on-demand",
    });
    await writeConfig("jscpd-guardrail.local.json", {
      enabled: true,
      maxFindings: 3,
      fallowCoexistence: "allow",
    });
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: true });

    expect(result).toEqual({
      config: {
        enabled: true,
        timeoutMs: 45_000,
        maxFindings: 3,
        fallowCoexistence: "allow",
      },
      sources: ["defaults", "project", "local"],
      diagnostics: [],
      trusted: true,
    });
  });

  it("does not inspect project-local files when Pi has not trusted the project", async () => {
    await writeConfig("jscpd-guardrail.json", "{ malformed private body");
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: false });

    expect(result).toEqual({
      config: DEFAULT_JSCPD_CONFIG,
      sources: ["defaults"],
      diagnostics: [],
      trusted: false,
    });
  });

  it.each([
    ["{ malformed", "malformed-json"],
    [[], "invalid-top-level"],
    [{ futureSetting: true }, "unknown-field"],
    [{ timeoutMs: 99, maxFindings: 0 }, "invalid-value"],
    [{ fallowCoexistence: "sometimes" }, "invalid-value"],
  ] as const)("rejects an invalid project source atomically: %j", async (value, code) => {
    await writeConfig("jscpd-guardrail.json", value);
    await writeConfig("jscpd-guardrail.local.json", { maxFindings: 4 });
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: true });

    expect(result.config).toEqual({
      enabled: true,
      timeoutMs: 30_000,
      maxFindings: 4,
      fallowCoexistence: "auto",
    });
    expect(result.sources).toEqual(["defaults", "local"]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ source: "project", code })]);
    expect(JSON.stringify(result)).not.toContain("malformed private body");
  });

  it("bounds configuration files and reported unknown field names", async () => {
    await writeConfig("jscpd-guardrail.json", "x".repeat(64 * 1_024 + 1));
    await writeConfig("jscpd-guardrail.local.json", {
      ["private-".repeat(40)]: true,
    });
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: true });

    expect(result.diagnostics.map(({ code }) => code)).toEqual(["file-too-large", "unknown-field"]);
    expect(result.diagnostics[1]?.message.length).toBeLessThan(300);
  });

  it("rejects a configuration file that resolves outside the project", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ enabled: false }));
    await symlink(outside, join(configDirectory, "jscpd-guardrail.json"));
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: projectDirectory, trusted: true });

    expect(result.sources).toEqual(["defaults"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ source: "project", code: "unsafe-file" }),
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("reports an unavailable trusted project without exposing its path", async () => {
    const service = createJscpdConfigService();

    const result = await service.load({ cwd: join(root, "missing"), trusted: true });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ source: "project", code: "invalid-project" }),
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
