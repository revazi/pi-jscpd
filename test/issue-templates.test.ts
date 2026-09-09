import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = process.cwd();
const directory = ".github/ISSUE_TEMPLATE";
const text = Type.String({ minLength: 1 });
const objectOptions = { additionalProperties: false } as const;
const validations = Type.Optional(Type.Object({ required: Type.Boolean() }, objectOptions));
const fieldProperties = {
  id: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }),
  validations,
};
const commonAttributes = {
  label: text,
  description: Type.Optional(text),
};
const choices = Type.Array(text, { minItems: 1, uniqueItems: true });

// Deliberately validate the documented GitHub fields used here, not every
// possible form feature. Adding a new field requires a reviewed schema update.
const fieldSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("markdown"),
      attributes: Type.Object({ value: text }, objectOptions),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...fieldProperties,
      type: Type.Union([Type.Literal("input"), Type.Literal("textarea")]),
      attributes: Type.Object(
        { ...commonAttributes, placeholder: Type.Optional(text) },
        objectOptions,
      ),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...fieldProperties,
      type: Type.Literal("dropdown"),
      attributes: Type.Object(
        { ...commonAttributes, multiple: Type.Optional(Type.Boolean()), options: choices },
        objectOptions,
      ),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...fieldProperties,
      type: Type.Literal("checkboxes"),
      attributes: Type.Object(
        {
          ...commonAttributes,
          options: Type.Array(
            Type.Object({ label: text, required: Type.Optional(Type.Boolean()) }, objectOptions),
            { minItems: 1 },
          ),
        },
        objectOptions,
      ),
    },
    objectOptions,
  ),
]);
const formSchema = Type.Object(
  {
    name: text,
    description: text,
    title: text,
    labels: choices,
    body: Type.Array(fieldSchema, { minItems: 1 }),
  },
  objectOptions,
);
const configSchema = Type.Object(
  {
    blank_issues_enabled: Type.Boolean(),
    contact_links: Type.Array(Type.Object({ name: text, url: text, about: text }, objectOptions), {
      minItems: 1,
    }),
  },
  objectOptions,
);

function projectText(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function parsedYaml(path: string): unknown {
  const document = parseDocument(projectText(path), { uniqueKeys: true });
  expect(document.errors, path).toEqual([]);
  expect(document.warnings, path).toEqual([]);
  return document.toJS();
}

function form(path: string) {
  const parsed = parsedYaml(`${directory}/${path}`);
  if (!Value.Check(formSchema, parsed)) throw new Error(`Invalid issue form: ${path}`);
  return parsed;
}

const feedbackPath = "adoption-feedback.yml";
const feedback = form(feedbackPath);

function field(id: string) {
  const result = feedback.body.find((entry) => "id" in entry && entry.id === id);
  if (!result || !("id" in result)) throw new Error(`Missing feedback field: ${id}`);
  return result;
}

function dropdown(id: string) {
  const result = field(id);
  if (result.type !== "dropdown") throw new Error(`Expected dropdown: ${id}`);
  return result;
}

function checkRepositoryUrl(raw: string): void {
  const url = new URL(raw);
  expect(url.protocol).toBe("https:");
  expect(url.hostname).toBe("github.com");
  expect(url.pathname).toMatch(/^\/revazi\/pi-jscpd\//);
  if (url.pathname === "/revazi/pi-jscpd/issues/new") {
    const template = url.searchParams.get("template");
    expect(template).toMatch(/^[a-z-]+\.yml$/);
    expect(template).not.toBe("config.yml");
    form(template as string);
  } else if (url.pathname.startsWith("/revazi/pi-jscpd/blob/main/")) {
    const path = url.pathname.slice("/revazi/pi-jscpd/blob/main/".length);
    expect(path).not.toContain("..");
    expect(projectText(path).trim().length).toBeGreaterThan(0);
  } else {
    expect(url.pathname).toBe("/revazi/pi-jscpd/security/advisories/new");
  }
}

describe("issue forms and voluntary adoption feedback", () => {
  it("parses all form YAML and validates supported fields, choices, and unique IDs", () => {
    const files = readdirSync(resolve(root, directory)).filter(
      (path) => path.endsWith(".yml") && path !== "config.yml",
    );
    expect(files).toContain(feedbackPath);
    const forms = files.map(form);
    expect(new Set(forms.map((entry) => entry.name)).size).toBe(forms.length);
    for (const entry of forms) {
      const ids = entry.body.flatMap((item) => ("id" in item ? [item.id] : []));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("rejects unsupported form properties and non-string dropdown choices", () => {
    expect(Value.Check(formSchema, { ...feedback, telemetry: true })).toBe(false);
    expect(
      Value.Check(fieldSchema, {
        ...dropdown("expected-count"),
        attributes: { label: "Count", options: [0, "1–5"] },
      }),
    ).toBe(false);
    expect(
      Value.Check(fieldSchema, {
        ...dropdown("expected-count"),
        attributes: { label: "Count", options: ["0", "0"] },
      }),
    ).toBe(false);
  });

  it("retains the issue chooser and private security reporting", () => {
    const config = parsedYaml(`${directory}/config.yml`);
    if (!Value.Check(configSchema, config)) throw new Error("Invalid issue-template config");
    expect(config.blank_issues_enabled).toBe(false);
    for (const contact of config.contact_links) checkRepositoryUrl(contact.url);
    expect(config.contact_links.some((entry) => entry.url.endsWith("/advisories/new"))).toBe(true);
  });

  it("validates form Markdown URLs and README/contribution issue-template links locally", () => {
    const source = projectText(`${directory}/${feedbackPath}`);
    const urls = [...source.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]);
    expect(urls).toHaveLength(4);
    for (const url of urls) checkRepositoryUrl(url);
    for (const path of ["README.md", "CONTRIBUTING.md"]) {
      const markdown = projectText(path);
      expect(markdown).toContain(`issues/new?template=${feedbackPath}`);
      for (const match of markdown.matchAll(/\]\((https:\/\/[^)]+\/issues\/new\?[^)]+)\)/g)) {
        checkRepositoryUrl(match[1]);
      }
    }
  });

  it("explicitly prohibits sensitive evidence and requires a manual privacy review", () => {
    const intro = feedback.body[0];
    expect(intro.type).toBe("markdown");
    if (intro.type !== "markdown") throw new Error("Missing safety introduction");
    const review = field("privacy-review");
    if (review.type !== "checkboxes") throw new Error("Missing privacy checkboxes");
    for (const prohibited of [
      "credentials",
      "private paths",
      "source fragments",
      "raw reports",
      "raw child output",
      "terminal captures",
      "account/repository identifiers",
    ]) {
      expect(intro.attributes.value).toContain(prohibited);
      expect(review.attributes.options[0].label).toContain(prohibited);
    }
    expect(intro.attributes.value).toContain("not telemetry");
    expect(intro.attributes.value).toContain("Nothing is collected or submitted automatically");
    expect(intro.attributes.value).toContain("Submissions are public");
    expect(intro.attributes.value).toContain("no new scan");
    expect(review.attributes.options.every((option) => option.required === true)).toBe(true);
  });

  it("collects versions without requiring identifying project data", () => {
    for (const id of ["pi-version", "node-version", "extension-version"]) {
      const version = field(id);
      expect(version.type).toBe("input");
      if (!("validations" in version)) throw new Error("Missing version validation");
      expect(version.validations?.required).toBe(true);
      expect(version.attributes.description).toContain("Unknown");
    }
    const freeTextIds = feedback.body.flatMap((entry) =>
      entry.type === "input" || entry.type === "textarea" ? [entry.id] : [],
    );
    expect(freeTextIds).toEqual([
      "pi-version",
      "node-version",
      "extension-version",
      "observations",
    ]);
    const observations = field("observations");
    expect(observations.type).toBe("textarea");
    expect(observations.attributes.description).toContain("At most six short bullets");
  });

  it("uses buckets and unknown/untested options rather than exact repository measurements", () => {
    for (const id of [
      "repository-size",
      "formats",
      "scan-scope",
      "scan-latency",
      "baseline-latency",
      "cancellation",
      "coexistence",
      "review-coverage",
      "actionable-count",
      "expected-count",
      "uncertain-count",
    ]) {
      const entry = dropdown(id);
      expect(entry.attributes.options.some((option) => /Unknown/.test(option))).toBe(true);
      expect(entry.validations?.required).not.toBe(true);
    }
    expect(dropdown("repository-size").attributes.options).toContain("100–999 source files");
    expect(dropdown("baseline-latency").attributes.description).toContain(
      "do not infer it from startup time",
    );
    for (const id of ["actionable-count", "expected-count", "uncertain-count"]) {
      expect(dropdown(id).attributes.options).toEqual([
        "Not reviewed / Unknown",
        "0",
        "1–5",
        "6–20",
        "21–100",
        "More than 100",
      ]);
    }
    expect(dropdown("review-coverage").attributes.description).toContain(
      "Omitted findings are not clean or reviewed",
    );
  });

  it("separates defects, workflow feedback, and evidence-driven next directions", () => {
    expect(dropdown("feedback-kind").attributes.options).toEqual([
      "Workflow or onboarding feedback (no demonstrated defect)",
      "Suspected reproducible defect (prefer the bug report)",
      "Both workflow feedback and a suspected defect",
      "Unsure",
    ]);
    const painPoints = dropdown("pain-points").attributes.options.join("\n");
    for (const area of ["Installation", "navigation", "Configuration", "Team workflow"]) {
      expect(painPoints).toContain(area);
    }
    expect(dropdown("next-direction").attributes.options).toContain(
      "No new feature needed; existing workflow fits",
    );
    expect(dropdown("next-direction").attributes.description).toContain(
      "not a feature commitment or permission to refactor",
    );
  });
});
