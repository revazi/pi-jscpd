import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  private?: boolean;
  license?: string;
  author?: string;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  files?: string[];
  keywords?: string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
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

  it("cannot be published accidentally while the project is a scaffold", async () => {
    const manifest = await readManifest();
    expect(manifest.private).toBe(true);
  });

  it("runs Biome as part of the standard project check", async () => {
    const manifest = await readManifest();

    expect(manifest.devDependencies?.["@biomejs/biome"]).toBe("2.5.3");
    expect(manifest.scripts?.format).toBe("biome check --write .");
    expect(manifest.scripts?.lint).toBe("biome check .");
    expect(manifest.scripts?.check).toContain("npm run lint");
  });

  it("declares its license, maintainer, and public project links", async () => {
    const manifest = await readManifest();

    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toBe("Revaz Zakalashvili");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/revazi/pi-jscpd.git",
    });
    expect(manifest.homepage).toBe("https://github.com/revazi/pi-jscpd#readme");
    expect(manifest.bugs?.url).toBe("https://github.com/revazi/pi-jscpd/issues");
    expect(manifest.files).toContain("LICENSE");
  });
});
