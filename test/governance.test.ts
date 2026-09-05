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
      "npm run docs:check",
      "npm run repo:hygiene",
      "npm run architecture:check",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run pack:certify",
      "npm run pack:dry-run",
    ]) {
      expect(workflow).toContain(`run: ${command}`);
    }
    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[a-f0-9]{40}/);
  });

  it("keeps manual release readiness unprivileged and non-publishing", async () => {
    const workflow = await projectFile(".github/workflows/release-readiness.yml");

    expect(workflow).toContain("name: Release readiness (no publish)");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toMatch(/ref: \$\{\{ inputs\.reviewed_sha \}\}/);
    expect(workflow).toContain('= "0.1.0"');
    expect(workflow).toContain("Boolean(require('./package.json').private)");
    expect(workflow).toContain('= "false"');
    expect(workflow).toContain("npm run release:check");
    expect(workflow).toContain("- 22.19.0");
    expect(workflow).toContain("- 24.12.0");
    expect(workflow).not.toMatch(/npm\s+publish/i);
    expect(workflow).not.toMatch(/(?:id-token|contents|packages):\s*write/i);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
    for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  it("stages the pi-fallow-style trusted-publishing release workflow", async () => {
    const workflow = await projectFile(".github/workflows/release.yml");

    expect(workflow).toContain("name: Release");
    expect(workflow).toContain('tags:\n      - "v*.*.*"');
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("npm@11.6.2");
    expect(workflow).toContain("Boolean(require('./package.json').private)");
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("npm run release:check");
    expect(workflow).toContain("npm publish --access public --provenance --ignore-scripts");
    expect(workflow).toContain(
      'gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes',
    );
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  it("defines deliberate npm and workflow dependency updates", async () => {
    const dependabot = await projectFile(".github/dependabot.yml");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot.match(/interval: monthly/g)).toHaveLength(2);
    expect(dependabot).toContain('dependency-name: "@earendil-works/pi-*"');
    expect(dependabot).toContain("version-update:semver-minor");
    expect(dependabot).toContain("dependency-name: vitest");
    expect(dependabot).toContain("Effect is intentionally excluded");
    expect(dependabot).not.toContain("dependency-name: effect");
    expect(dependabot).not.toContain("dependency-type: direct");
    expect(dependabot).toContain("reviewers:\n      - revazi");
  });

  it("keeps private agent state and local overrides ignored", async () => {
    const gitignore = await projectFile(".gitignore");

    expect(gitignore).toContain("/.agents/");
    expect(gitignore).toContain("/AGENTS.md");
    expect(gitignore).toContain("/work/");
    expect(gitignore).toContain("/outputs/");
    expect(gitignore).toContain("/reports/");
    expect(gitignore).toContain("/.npmrc");
    expect(gitignore).toContain("/.env.*");
    expect(gitignore).toContain(".pi/jscpd-guardrail.local.json");
  });

  it("packages one on-demand jscpd skill with the extension", async () => {
    const manifest = JSON.parse(await projectFile("package.json")) as {
      files?: string[];
      pi?: { extensions?: string[]; skills?: string[] };
    };
    const skill = await projectFile("skills/jscpd/SKILL.md");

    expect(manifest.files).toContain("skills");
    expect(manifest.pi).toEqual({
      extensions: ["./src/index.ts"],
      skills: ["./skills/jscpd/SKILL.md"],
    });
    expect(skill).toMatch(/^---\nname: jscpd\ndescription: .+\nlicense: MIT\n/);
    expect(skill).toContain("Prefer the `jscpd_run` tool");
    expect(skill).toContain("Never refactor, delete, or");
    expect(skill).toContain("When status reports that Fallow duplication overlap");
  });

  it("publishes contribution, security, change, issue, and PR guidance", async () => {
    const paths = [
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/release.md",
      "docs/effect-architecture.md",
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
    expect(contents[3]).toContain("The first public release is `0.1.0`");
    expect(contents[3]).toContain("Effect architecture");
    expect(contents[3]).toContain("trusted publishing");
    expect(contents[4]).toContain("ManagedRuntime");
    expect(contents[4]).toContain("Certification proves only");
    expect(contents[5]).toContain("* @revazi");
  });
});
