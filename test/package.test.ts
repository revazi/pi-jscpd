import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  author?: { name?: string; url?: string };
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  files?: string[];
  keywords?: string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: { node?: string };
  pi?: { extensions?: string[] };
}

async function readManifest(): Promise<PackageManifest> {
  const manifestPath = resolve(process.cwd(), "package.json");
  return JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
}

describe("Pi package manifest", () => {
  it("declares one explicit extension entrypoint", async () => {
    const manifest = await readManifest();

    expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.keywords).toContain("pi-package");
  });

  it("cannot be published accidentally before the release milestone", async () => {
    const manifest = await readManifest();
    expect(manifest.private).toBe(true);
  });

  it("pins tested fixtures while keeping supported host packages as peers", async () => {
    const manifest = await readManifest();
    const piPackages = [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ];

    expect(manifest.engines?.node).toBe(">=22.19.0 <23 || >=24 <25");
    for (const name of piPackages) {
      expect(manifest.peerDependencies?.[name]).toBe(">=0.84.4 <0.85.0");
      expect(manifest.devDependencies?.[name]).toBe("0.84.4");
    }
    expect(manifest.peerDependencies?.typebox).toBe(">=1.3.7 <2");
    expect(manifest.devDependencies?.typebox).toBe("1.3.7");
  });

  it("runs pinned tooling and compatibility validation in the standard check", async () => {
    const manifest = await readManifest();

    expect(manifest.devDependencies).toMatchObject({
      "@biomejs/biome": "2.5.3",
      "@types/node": "22.19.19",
      typescript: "5.9.3",
      vitest: "4.1.11",
    });
    expect(manifest.scripts?.format).toBe(
      "biome check --write src test scripts package.json tsconfig.json biome.json",
    );
    expect(manifest.scripts?.lint).toBe(
      "biome check src test scripts package.json tsconfig.json biome.json",
    );
    expect(manifest.scripts?.["compatibility:check"]).toBe("node scripts/check-compatibility.mjs");
    expect(manifest.scripts?.check).toBe(
      "npm run compatibility:check && npm run typecheck && npm run lint && npm test",
    );
  });

  it("declares its license, maintainer, and public project links", async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe("pi-jscpd");
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toEqual({
      name: "Revaz Zakalashvili",
      url: "https://github.com/revazi",
    });
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/revazi/pi-jscpd.git",
    });
    expect(manifest.homepage).toBe("https://github.com/revazi/pi-jscpd#readme");
    expect(manifest.bugs?.url).toBe("https://github.com/revazi/pi-jscpd/issues");
    expect(manifest.files).toEqual([
      "src",
      "docs",
      "scripts/check-compatibility.mjs",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "README.md",
      "LICENSE",
    ]);
  });
});
