import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderJscpdToolCall, renderJscpdToolResult } from "../src/tool-render.js";
import type { JscpdDispatchResult } from "../src/types.js";

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function rendered(component: { render(width: number): string[] }, width = 100): string {
  const lines = component.render(width);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  return lines.map((line) => line.trimEnd()).join("\n");
}

const completedFindings = {
  status: "completed",
  outcome: "findings",
  message: "Model-facing result.",
  terminalMessage: "jscpd found 2 duplicate blocks.\ncurrent location: src/a.ts:1-5",
  summary: {
    clones: 2,
    duplicatedLines: 10,
    duplicatedTokens: 40,
    lines: 100,
    tokens: 500,
    sources: 4,
    percentage: 10,
    percentageTokens: 8,
  },
  findings: [],
  omittedFindings: 2,
} as const satisfies JscpdDispatchResult;

describe("jscpd_run transcript rendering", () => {
  it("renders the operation, bounded scan targets, and Pi working directory", () => {
    const component = renderJscpdToolCall(
      {
        command: "scan",
        args: ["src", "two words", "test", "fourth-secret-target"],
      },
      theme(),
      "/project root",
    );

    const output = rendered(component, 34).replace(/\s*\n\s*/gu, " ");
    expect(output).toContain("jscpd scan");
    expect(output).toContain("src");
    expect(output).toContain('"two words"');
    expect(output).toContain("… +1");
    expect(output).toContain('in "/project root"');
    expect(output).not.toContain("fourth-secret-target");
  });

  it("escapes control characters in call arguments instead of emitting terminal sequences", () => {
    const output = rendered(
      renderJscpdToolCall(
        { command: "scan", args: ["src/\u001b[31munsafe.ts"] },
        theme(),
        "/project",
      ),
    );

    expect(output).toContain("\\u001b");
    expect(output).not.toContain("\u001b[31m");
  });

  it("renders compact clean and findings summaries without implementation placeholders", () => {
    const clean = {
      ...completedFindings,
      outcome: "clean" as const,
      terminalMessage: "jscpd scan clean.",
      summary: { ...completedFindings.summary, clones: 0, duplicatedLines: 0 },
      omittedFindings: 0,
    };

    expect(rendered(renderJscpdToolResult({ details: clean }, {}, theme()))).toBe(
      "No duplicate blocks found · 4 sources",
    );
    expect(rendered(renderJscpdToolResult({ details: completedFindings }, {}, theme()))).toBe(
      "2 duplicate blocks found · 10 duplicated lines",
    );
  });

  it("renders changed findings from configured public findings and omission counts", () => {
    const details = {
      status: "changed",
      outcome: "findings",
      scanPerformed: true,
      message: "Changed model result.",
      terminalMessage: "Changed terminal result.",
      findings: [{ safe: true }],
      omittedFindings: 2,
      ambiguousFindings: 1,
    } as unknown as JscpdDispatchResult;

    expect(rendered(renderJscpdToolResult({ details }, {}, theme()))).toBe(
      "3 new duplicate blocks found · 1 unclassified block",
    );
  });

  it.each([
    [
      { status: "unavailable", reason: "missing-binary", message: "missing" },
      "jscpd unavailable · analyzer missing",
    ],
    [{ status: "failed", reason: "scan-timed-out", message: "timeout" }, "jscpd scan timed out"],
    [{ status: "failed", reason: "scan-cancelled", message: "cancelled" }, "jscpd scan cancelled"],
    [
      { status: "failed", reason: "process-failed", message: "failed" },
      "jscpd scan failed open · process failed",
    ],
    [
      { status: "changed-unavailable", reason: "baseline-timed-out", message: "timeout" },
      "Changed check timed out",
    ],
    [
      { status: "changed-unavailable", reason: "baseline-cancelled", message: "cancelled" },
      "Changed check cancelled",
    ],
  ] as const)("renders expected fail-open state %#", (details, expected) => {
    const output = rendered(renderJscpdToolResult({ details }, {}, theme()));
    expect(output).toBe(expected);
    expect(output).not.toMatch(/undefined|exit|duration/i);
  });

  it("renders bounded status and session-control summaries", () => {
    const status = {
      status: "status",
      message: "status",
      terminalMessage: "status terminal",
      mode: "enabled",
      modeSource: "configuration",
      configSource: "defaults",
      configSources: ["defaults"],
      configDiagnostics: 0,
      capability: {
        status: "available",
        executable: "jscpd",
        version: "5.1.2",
        major: 5,
        source: "bundled",
      },
      lastCheck: { state: "findings", clones: 2 },
    } as const satisfies JscpdDispatchResult;

    expect(rendered(renderJscpdToolResult({ details: status }, {}, theme()))).toBe(
      "jscpd enabled · jscpd 5.1.2 bundled · last check 2 blocks",
    );
    expect(
      rendered(
        renderJscpdToolResult(
          {
            details: {
              status: "control",
              action: "disabled",
              message: "off",
              terminalMessage: "off",
            },
          },
          {},
          theme(),
        ),
      ),
    ).toBe("jscpd disabled for this session");
  });

  it("uses only public result details for expanded output", () => {
    const details = {
      ...completedFindings,
      overlayCache: {
        findings: [{ sourceFragment: "OVERLAY-ONLY-SECRET" }],
        omittedFindings: 0,
      },
      rawOutput: "RAW-CHILD-OUTPUT",
      temporaryPath: "/tmp/private-report",
      environment: "PRIVATE_ENVIRONMENT",
    };
    const output = rendered(
      renderJscpdToolResult(
        { details, content: [{ type: "text", text: "UNTRUSTED-CONTENT" }] } as unknown as {
          details: unknown;
        },
        { expanded: true },
        theme(),
      ),
      38,
    );

    expect(output).toContain("jscpd found 2 duplicate blocks.");
    expect(output).toContain("src/a.ts:1-5");
    expect(output).not.toMatch(
      /OVERLAY-ONLY-SECRET|RAW-CHILD-OUTPUT|private-report|PRIVATE_ENVIRONMENT|UNTRUSTED-CONTENT/,
    );
  });

  it("keeps partial, absent, and malformed results compact and safe at narrow widths", () => {
    const cases = [
      renderJscpdToolResult({}, { isPartial: true }, theme()),
      renderJscpdToolResult({}, {}, theme()),
      renderJscpdToolResult({ details: { status: "unexpected", message: "secret" } }, {}, theme()),
      ...[
        "completed",
        "unavailable",
        "failed",
        "status",
        "control",
        "help",
        "changed",
        "changed-unavailable",
        "invalid",
        "error",
      ].map((status) => renderJscpdToolResult({ details: { status } }, {}, theme())),
      renderJscpdToolCall(
        { command: undefined, args: "not-an-array" },
        theme(),
        "/very/narrow/project",
      ),
    ];

    for (const component of cases) {
      const output = rendered(component, 12);
      expect(output).not.toContain("undefined");
      expect(output).not.toContain("secret");
    }
  });
});
