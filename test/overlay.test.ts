import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createJscpdOverlayLauncher, JscpdOverlayComponent } from "../src/overlay.js";
import type {
  JscpdCommandExecutor,
  JscpdExecutionResult,
  JscpdStatusResult,
} from "../src/types.js";

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

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
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
  const done = vi.fn(options.done);
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
          width: "80%",
          minWidth: 32,
          maxHeight: "80%",
          margin: 1,
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
      { cwd: "/project", signal: expect.any(AbortSignal) },
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
      expect(lines.length).toBeLessThanOrEqual(8);
    }
    expect(loading.instance.render(30).join("\n")).toContain("Loading status");

    resolveStatus(statusResult);
    await waitForReady(loading.instance);
    for (const width of [100, 52, 30, 3]) {
      const lines = loading.instance.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(8);
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
    expect(overlay.instance.render(100).join("\n")).toContain("reinstall pi-jscpd");
    overlay.instance.dispose();
  });

  it("runs explicit changed checks, navigates findings/detail, and filters literally", async () => {
    const service = executor(async ({ command }) =>
      command === "status" ? statusResult : findingsResult,
    );
    const overlay = component(service);
    await waitForReady(overlay.instance);

    overlay.instance.handleInput("c");
    await vi.waitFor(() =>
      expect(overlay.instance.render(100).join("\n")).toContain("src/new-implementation.ts"),
    );
    expect(service.execute).toHaveBeenNthCalledWith(
      2,
      { command: "changed", args: [] },
      { cwd: "/project", signal: expect.any(AbortSignal) },
    );
    expect(overlay.instance.render(100).join("\n")).toContain("3 additional findings omitted");

    overlay.instance.handleInput("return");
    const detail = overlay.instance.render(100).join("\n");
    expect(detail).toContain("new in this session");
    expect(detail).toContain("existing match");
    expect(detail).toContain("12 lines | 60 tokens | typescript");
    expect(detail).toContain("inspect both locations and surrounding behavior");
    expect(detail).toContain("jscpd ignore/exclusion");
    expect(detail).toContain("1 removed, 1 remaining, 0 newly created");

    overlay.instance.handleInput("escape");
    overlay.instance.handleInput("\t");
    expect(overlay.instance.render(100).join("\n")).toContain(
      "Verification since the previous matching changed scan",
    );
    overlay.instance.handleInput("\t");
    overlay.instance.handleInput("/");
    for (const character of "other") overlay.instance.handleInput(character);
    const filtered = overlay.instance.render(100).join("\n");
    expect(filtered).toContain("src/other.ts");
    expect(filtered).not.toContain("src/new-implementation.ts");
    overlay.instance.dispose();
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
    expect(overlay.instance.render(80).join("\n")).toContain("> Scan project");
    overlay.instance.handleInput("?");
    expect(overlay.instance.render(80).join("\n")).toContain("Advisory only");
    overlay.instance.handleInput("escape");
    expect(overlay.instance.render(80).join("\n")).toContain("Check session changes");
    overlay.instance.handleInput("\u0003");
    expect(overlay.done).toHaveBeenCalledOnce();
  });
});
