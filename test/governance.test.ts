import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function projectFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("public repository safeguards", () => {
  it("runs bounded CI checks on both supported Node fixtures", async () => {
    const workflow = await projectFile(".github/workflows/ci.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("- 22.19.0");
    expect(workflow).toContain("- 24.12.0");
    expect(workflow).toContain("run: npm ci --ignore-scripts");
    for (const command of [
      "npm run compatibility:check",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run pack:dry-run",
    ]) {
      expect(workflow).toContain(`run: ${command}`);
    }
    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[a-f0-9]{40}/);
  });

  it("defines deliberate npm and workflow dependency updates", async () => {
    const dependabot = await projectFile(".github/dependabot.yml");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot.match(/interval: monthly/g)).toHaveLength(2);
    expect(dependabot).toContain('dependency-name: "@earendil-works/pi-*"');
    expect(dependabot).toContain("version-update:semver-minor");
    expect(dependabot).toContain("reviewers:\n      - revazi");
  });

  it("keeps private agent state and local overrides ignored", async () => {
    const gitignore = await projectFile(".gitignore");

    expect(gitignore).toContain("/.agents/");
    expect(gitignore).toContain("/AGENTS.md");
    expect(gitignore).toContain("/work/");
    expect(gitignore).toContain(".pi/jscpd-guardrail.local.json");
  });

  it("publishes contribution, security, change, issue, and PR guidance", async () => {
    const paths = [
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/bug-report.yml",
      ".github/ISSUE_TEMPLATE/feature-request.yml",
      ".github/pull_request_template.md",
    ];

    const contents = await Promise.all(paths.map(projectFile));
    for (const content of contents) expect(content.trim().length).toBeGreaterThan(20);
    expect(contents[1]).toContain("Validate (Node 22.19.0)");
    expect(contents[1]).toContain("Validate (Node 24.12.0)");
    expect(contents[1]).toContain("Only [Revaz Zakalashvili]");
    expect(contents[2]).toContain("private vulnerability reporting");
    expect(contents[3]).toContain("* @revazi");
  });
});
