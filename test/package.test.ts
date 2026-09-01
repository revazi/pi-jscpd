import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  private?: boolean;
  keywords?: string[];
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
});
