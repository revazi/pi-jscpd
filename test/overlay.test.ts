import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  buildJscpdOverlayPrompt,
  createJscpdOverlayLauncher,
  type JscpdOverlayExecutor as JscpdCommandExecutor,
  JscpdOverlayComponent,
  type JscpdOverlayPromptResult,
} from "../src/overlay.js";
import type { JscpdExecutionResult, JscpdStatusResult } from "../src/types.js";

const statusResult: JscpdStatusResult = {
  status: "status",
  message: "jscpd status",
  terminalMessage: "jscpd status\nMode: enabled\nBinary: jscpd v5.1.0",
  mode: "enabled",
  modeSource: "configuration",
  configSource: "defaults",
  configSources: ["defaults"],
  configDiagnostics: 0,
  capability: { status: "available", executable: "jscpd", version: "5.1.0", major: 5 },
  lastCheck: { state: "never" },
};

const findingsResult = {
  status: "changed",
  outcome: "findings",
  scanPerformed: true,
  message: "new duplicate block",
  terminalMessage: "new duplicate block",
  findings: [
    {
      format: "typescript",
      lines: 12,
      tokens: 60,
      occurrences: [
        {
          path: "src/new-implementation.ts",
          startLine: 10,
          endLine: 21,
          relation: "new-session",
        },
        {
          path: "src/existing-implementation.ts",
          startLine: 40,
          endLine: 51,
          relation: "existing-match",
        },
      ],
    },
    {
      format: "typescript",
      lines: 8,
      tokens: 35,
      occurrences: [
        { path: "src/other.ts", startLine: 1, endLine: 8, relation: "new-session" },
        { path: "src/match.ts", startLine: 3, endLine: 10, relation: "existing-match" },
      ],
    },
  ],
  omittedFindings: 3,
  ambiguousFindings: 0,
  verification: {
    state: "compared",
    scope: "changed",
    removed: 1,
    remaining: 1,
    created: 0,
    ambiguous: 0,
    message:
      "Verification since the previous matching changed scan: 1 removed, 1 remaining, 0 newly created.",
  },
} as const satisfies JscpdExecutionResult;

function findingAt(index: number) {
  const finding = findingsResult.findings[index % findingsResult.findings.length];
  if (!finding) throw new Error("Expected a representative overlay finding.");
  return finding;
}

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function keybindings(): KeybindingsManager {
  const keys: Record<string, string> = {
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.select.pageUp": "pageup",
    "tui.select.pageDown": "pagedown",
    "tui.select.confirm": "return",
    "tui.select.cancel": "escape",
  };
  return {
    matches: (data: string, binding: string) => keys[binding] === data,
  } as unknown as KeybindingsManager;
}

function tui(rows = 30) {
  const requestRender = vi.fn();
  return {
    service: {
      terminal: { rows },
      requestRender,
    } as unknown as TUI,
    requestRender,
  };
}

function executor(
  execute: JscpdCommandExecutor["execute"] = async () => statusResult,
): JscpdCommandExecutor & { execute: ReturnType<typeof vi.fn<JscpdCommandExecutor["execute"]>> } {
  const mock = vi.fn<JscpdCommandExecutor["execute"]>(execute);
  return { execute: mock };
}

function component(
  service: JscpdCommandExecutor,
  options: { rows?: number; signal?: AbortSignal; done?: () => void } = {},
) {
  const terminal = tui(options.rows);
  const done = vi.fn<(result: JscpdOverlayPromptResult | null) => void>(options.done ?? (() => {}));
  const instance = new JscpdOverlayComponent({
    tui: terminal.service,
    theme: theme(),
    keybindings: keybindings(),
    executor: service,
    cwd: "/project",
    signal: options.signal,
    changedFileCount: () => 3,
    done,
  });
  return { instance, done, requestRender: terminal.requestRender };
}

async function waitForReady(instance: JscpdOverlayComponent): Promise<void> {
  await vi.waitFor(() => expect(instance.render(80).join("\n")).toContain("enabled"));
}

describe("jscpd overlay launcher", () => {
  it("opens exactly one centered bounded overlay in TUI mode", async () => {
    const service = executor();
    let created: JscpdOverlayComponent | undefined;
    const custom = vi.fn(async (factory, options) => {
      created = factory(tui().service, theme(), keybindings(), vi.fn());
      expect(options).toEqual({
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          minWidth: 50,
          maxHeight: "95%",
        },
      });
    });
    const launcher = createJscpdOverlayLauncher(service, { changedFileCount: () => 2 });
    const context = {
      mode: "tui",
      cwd: "/project",
      signal: undefined,
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionCommandContext;

    await launcher.open(context);

    expect(custom).toHaveBeenCalledOnce();
    expect(created).toBeInstanceOf(JscpdOverlayComponent);
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalledOnce());
    expect(service.execute).toHaveBeenCalledWith(
      { command: "status", args: [] },
      {
        cwd: "/project",
        signal: expect.any(AbortSignal),
        overlayFindingLimit: 100,
      },
    );
    created?.dispose();
  });

  it("uses a bounded RPC notification fallback without opening an overlay or scanning", async () => {
    const service = executor();
    const notify = vi.fn();
    const custom = vi.fn();
    const launcher = createJscpdOverlayLauncher(service);
    const context = {
      mode: "rpc",
      cwd: "/project",
      signal: undefined,
      ui: { custom, notify },
    } as unknown as ExtensionCommandContext;

    await launcher.open(context);

    expect(custom).not.toHaveBeenCalled();
    expect(service.execute).toHaveBeenCalledWith(
      { command: "status", args: [] },
      { cwd: "/project", signal: undefined },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(
        /^The \/jscpd overlay requires Pi TUI mode\.\njscpd status.*Use \/jscpd changed/s,
      ),
      "info",
    );
    expect(service.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "scan" }),
      expect.anything(),
    );
  });

  it("prefills the editor only after the overlay returns an explicit prompt result", async () => {
    let resolveOverlay!: (value: {
      type: "prompt";
      prompt: string;
      findingCount: number;
      omittedSelectionCount: number;
    }) => void;
    const custom = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveOverlay = resolve;
        }),
    );
    const setEditorText = vi.fn();
    const notify = vi.fn();
    const launcher = createJscpdOverlayLauncher(executor());
    const context = {
      mode: "tui",
      cwd: "/project",
      signal: undefined,
      ui: { custom, setEditorText, notify },
    } as unknown as ExtensionCommandContext;

    const opened = launcher.open(context);
    expect(setEditorText).not.toHaveBeenCalled();
    resolveOverlay({
      type: "prompt",
      prompt: "Inspect these duplicate blocks.",
      findingCount: 2,
      omittedSelectionCount: 1,
    });
    await opened;

    expect(setEditorText).toHaveBeenCalledWith("Inspect these duplicate blocks.");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Loaded 2 jscpd duplicate blocks into the editor"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 additional selection"), "info");
  });

  it.each(["json", "print"] as const)(
    "writes one plain fallback to stderr in %s mode and fails open when it is closed",
    async (mode) => {
      const service = executor();
      const writes: string[] = [];
      const launcher = createJscpdOverlayLauncher(service, {
        writeFallback: (text) => {
          writes.push(text);
          if (mode === "json") throw new Error("closed");
        },
      });
      const context = {
        mode,
        cwd: "/project",
        signal: undefined,
        ui: { custom: vi.fn(), notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      await expect(launcher.open(context)).resolves.toBeUndefined();

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("The /jscpd overlay requires Pi TUI mode.");
      expect(service.execute).toHaveBeenCalledOnce();
      expect(service.execute).toHaveBeenCalledWith(
        { command: "status", args: [] },
        { cwd: "/project", signal: undefined },
      );
    },
  );
});

describe("jscpd overlay component", () => {
  it("renders loading and responsive ready overviews within width and height bounds", async () => {
    let resolveStatus!: (value: JscpdExecutionResult) => void;
    const service = executor(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const loading = component(service, { rows: 10 });

    for (const width of [100, 52, 30, 3]) {
      const lines = loading.instance.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(9);
    }
    expect(loading.instance.render(30).join("\n")).toContain("Loading status");

    resolveStatus(statusResult);
    await waitForReady(loading.instance);
    for (const width of [100, 52, 30, 3]) {
      const lines = loading.instance.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(9);
    }
    expect(loading.instance.render(80).join("\n")).toContain("3 session-changed files");
    loading.instance.invalidate();
    loading.instance.dispose();
  });

  it("shows missing-binary recovery without allowing scan shortcuts", async () => {
    const missing: JscpdStatusResult = {
      ...statusResult,
      capability: { status: "missing", checked: ["jscpd", "cpd"] },
    };
    const service = executor(async () => missing);
    const overlay = component(service);
    await vi.waitFor(() =>
      expect(overlay.instance.render(80).join("\n")).toContain("jscpd v5 not found"),
    );

    overlay.instance.handleInput("c");
    overlay.instance.handleInput("s");

    expect(service.execute).toHaveBeenCalledOnce();
    expect(overlay.instance.render(80).join("\n")).toContain("Refresh status");
    expect(overlay.instance.render(80).join("\n")).not.toContain("Scan project");
    overlay.instance.handleInput("?");
    expect(overlay.instance.render(100).join("\n")).toContain("Reinstall pi-jscpd");
    overlay.instance.dispose();
  });

  it("runs explicit changed checks and renders usable Fallow-style findings", async () => {
    const service = executor(async ({ command }) =>
      command === "status" ? statusResult : findingsResult,
    );
    const overlay = component(service);
    await waitForReady(overlay.instance);

    overlay.instance.handleInput("c");
    await vi.waitFor(() => expect(overlay.instance.render(100).join("\n")).toContain("2 shown"));
    expect(service.execute).toHaveBeenNthCalledWith(
      2,
      { command: "changed", args: [] },
      {
        cwd: "/project",
        signal: expect.any(AbortSignal),
        overlayFindingLimit: 100,
      },
    );
    const list = overlay.instance.render(100).join("\n");
    expect(list).toContain("src/new-implem");
    expect(list).toContain("ation.ts:10-21");
    expect(list).toContain("src/existing-i");
    expect(list).toContain("ation.ts:40-51");
    expect(list).toContain("12L/60T typescript");
    expect(list).toContain("2 shown");
    expect(list).toContain("5 total");
    expect(list).toContain("3 not retained (display limit)");

    overlay.instance.handleInput("return");
    const detail = overlay.instance.render(100).join("\n");
    expect(detail).toContain("new in this session");
    expect(detail).toContain("existing match");
    expect(detail).toContain("12 lines | 60 tokens | typescript");
    expect(detail).toContain("inspect both locations and surrounding behavior");
    expect(detail).toContain("1 removed, 1 remaining, 0 newly");
    expect(detail).toContain("created.");

    overlay.instance.handleInput("h");
    expect(overlay.instance.render(100).join("\n")).not.toContain("new in this session:");
    overlay.instance.handleInput("/");
    for (const character of "other") overlay.instance.handleInput(character);
    overlay.instance.handleInput("\r");
    const filtered = overlay.instance.render(100).join("\n");
    expect(filtered).toContain("1/2 shown");
    expect(filtered).toContain("src/other.ts");
    expect(filtered).not.toContain("src/new-implem");
    overlay.instance.handleInput("x");
    expect(overlay.instance.render(100).join("\n")).toContain("src/new-implem");
    overlay.instance.dispose();
  });

  it("supports Fallow-style navigation, selection, search editing, and bounded prompt handoff", async () => {
    const service = executor(async ({ command }) =>
      command === "status" ? statusResult : findingsResult,
    );
    const overlay = component(service);
    await waitForReady(overlay.instance);
    overlay.instance.handleInput("c");
    await vi.waitFor(() => expect(overlay.instance.render(100).join("\n")).toContain("2 shown"));

    overlay.instance.handleInput("s");
    overlay.instance.handleInput("down");
    expect(overlay.instance.render(100).join("\n")).toMatch(/❯.*src\/other\.ts/);
    overlay.instance.handleInput("\t");
    expect(overlay.instance.render(100).join("\n")).toContain("2 selected");

    overlay.instance.handleInput("\u001b[H");
    expect(overlay.instance.render(100).join("\n")).toMatch(/❯.*src\/new-implem/);
    overlay.instance.handleInput("\u001b[F");
    overlay.instance.handleInput("\u001b[C");
    expect(overlay.instance.render(100).join("\n")).toContain("existing match");
    overlay.instance.handleInput("\u001b[D");
    expect(overlay.instance.render(100).join("\n")).not.toContain("existing match:");
    overlay.instance.handleInput(" ");
    expect(overlay.instance.render(100).join("\n")).toContain("Duplicate block 2 of 5");

    overlay.instance.handleInput("/");
    for (const character of "new") overlay.instance.handleInput(character);
    overlay.instance.handleInput("escape");
    expect(overlay.instance.render(100).join("\n")).toContain("2 shown");
    overlay.instance.handleInput("/");
    for (const character of "other") overlay.instance.handleInput(character);
    overlay.instance.handleInput("\u0015");
    overlay.instance.handleInput("\r");
    expect(overlay.instance.render(100).join("\n")).toContain("2 shown");

    overlay.instance.handleInput("e");
    expect(overlay.done).toHaveBeenCalledOnce();
    const promptResult = overlay.done.mock.calls[0]?.[0];
    expect(promptResult).toMatchObject({ type: "prompt", findingCount: 2 });
    expect(promptResult?.prompt).toContain("src/new-implementation.ts:10-21");
    expect(promptResult?.prompt).toContain("src/other.ts:1-8");
    expect(promptResult?.prompt).toContain("Duplication may be intentional");
    expect(promptResult?.prompt).not.toContain("fragment");
    expect(Array.from(promptResult?.prompt ?? "").length).toBeLessThanOrEqual(12_000);
  });

  it("keeps long result navigation scrollable and every rendered line bounded", async () => {
    const findings = Array.from({ length: 24 }, (_, index) => ({
      ...findingAt(index),
      occurrences: [
        {
          path: `src/generated/first-${index}.ts`,
          startLine: index + 1,
          endLine: index + 8,
          relation: "new-session" as const,
        },
        {
          path: `src/generated/second-${index}.ts`,
          startLine: index + 10,
          endLine: index + 17,
          relation: "existing-match" as const,
        },
      ] as const,
    }));
    const many = {
      ...findingsResult,
      findings: findings.slice(0, 10),
      omittedFindings: 14,
      overlayCache: { findings, omittedFindings: 0 },
    } satisfies JscpdExecutionResult;
    const service = executor(async ({ command }) => (command === "status" ? statusResult : many));
    const overlay = component(service, { rows: 10 });
    await waitForReady(overlay.instance);
    overlay.instance.handleInput("c");
    await vi.waitFor(() => expect(overlay.instance.render(52).join("\n")).toContain("first-0.ts"));
    expect(overlay.instance.render(52).join("\n")).toContain("10 shown");
    expect(overlay.instance.render(52).join("\n")).toContain("Load next 10 / L");
    expect(overlay.instance.render(52).join("\n")).not.toContain("first-10.ts");

    overlay.instance.handleInput("\u001b[F");
    overlay.instance.handleInput("down");
    expect(overlay.instance.render(52).join("\n")).toContain("first-10.ts");
    expect(overlay.instance.render(52).join("\n")).toContain("20 shown");

    overlay.instance.handleInput("L");
    overlay.instance.handleInput("\u001b[F");
    const rendered = overlay.instance.render(52);
    expect(rendered.join("\n")).toContain("earlier finding");
    expect(rendered.join("\n")).toContain("second-23.ts");
    expect(rendered.join("\n")).toContain("24 shown");
    expect(rendered.length).toBeLessThanOrEqual(9);
    expect(rendered.every((line) => visibleWidth(line) <= 52)).toBe(true);
    overlay.instance.handleInput("\u001b[5~");
    expect(overlay.instance.render(52).every((line) => visibleWidth(line) <= 52)).toBe(true);
    overlay.instance.dispose();
  });

  it("bounds generated prompts independently of the result-cache limit", () => {
    const findings = Array.from({ length: 40 }, () => findingAt(0));

    const prompt = buildJscpdOverlayPrompt(findings, "changed");

    expect(prompt.findingCount).toBeLessThanOrEqual(20);
    expect(Array.from(prompt.prompt).length).toBeLessThanOrEqual(12_000);
    expect(prompt.prompt).toContain("Review the following jscpd duplicate blocks");
  });

  it("propagates cancellation, waits for settlement, and closes idempotently", async () => {
    let changedSignal: AbortSignal | undefined;
    const service = executor(async ({ command }, context) => {
      if (command === "status") return statusResult;
      changedSignal = context.signal;
      return new Promise((resolve) => {
        context.signal?.addEventListener(
          "abort",
          () =>
            resolve({
              status: "failed",
              reason: "scan-cancelled",
              message: "cancelled safely",
            }),
          { once: true },
        );
      });
    });
    const overlay = component(service);
    await waitForReady(overlay.instance);

    overlay.instance.handleInput("c");
    await vi.waitFor(() => expect(changedSignal).toBeInstanceOf(AbortSignal));
    overlay.instance.handleInput("escape");
    expect(changedSignal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(overlay.instance.render(80).join("\n")).toContain("cancelled safely"),
    );
    expect(overlay.done).not.toHaveBeenCalled();

    overlay.instance.handleInput("q");
    overlay.instance.dispose();
    expect(overlay.done).toHaveBeenCalledOnce();
  });

  it("aborts and drops late completions when disposed or its command context ends", async () => {
    const outer = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const service = executor(async (_invocation, context) => {
      requestSignal = context.signal;
      return new Promise((resolve) => {
        context.signal?.addEventListener("abort", () => resolve(statusResult), { once: true });
      });
    });
    const overlay = component(service, { signal: outer.signal });
    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));

    outer.abort();
    expect(requestSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(overlay.done).toHaveBeenCalledOnce());
    overlay.instance.dispose();
    overlay.instance.dispose();
    expect(overlay.done).toHaveBeenCalledOnce();
  });

  it("supports configured navigation, help, and safe idle close", async () => {
    const service = executor();
    const overlay = component(service);
    await waitForReady(overlay.instance);

    overlay.instance.handleInput("down");
    expect(overlay.instance.render(80).join("\n")).toMatch(/❯.*Scan project/);
    overlay.instance.handleInput("?");
    expect(overlay.instance.render(80).join("\n")).toContain("Duplication is advisory");
    overlay.instance.handleInput("escape");
    expect(overlay.instance.render(80).join("\n")).toContain("Check session changes");
    overlay.instance.handleInput("\u0003");
    expect(overlay.done).toHaveBeenCalledOnce();
  });
});
