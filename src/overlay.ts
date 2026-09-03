import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  JscpdChangedFinding,
  JscpdCommand,
  JscpdCommandExecutor,
  JscpdExecutionResult,
  JscpdPresentedFinding,
  JscpdStatusResult,
} from "./types.js";

const FILTER_LIMIT = 256;
const OVERLAY_FINDING_LIMIT = 100;
const FALLBACK_ACTIONS = "Use /jscpd changed, /jscpd scan, /jscpd off|on, or /jscpd help.";
const FALLBACK_PREFIX = "The /jscpd overlay requires Pi TUI mode.";

export interface JscpdOverlayLauncher {
  open(context: ExtensionCommandContext): Promise<void>;
}

export interface JscpdOverlayLauncherOptions {
  readonly changedFileCount?: () => number;
  readonly writeFallback?: (text: string) => void;
}

export interface JscpdOverlayComponentOptions {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly executor: JscpdCommandExecutor;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly changedFileCount: () => number;
  readonly done: () => void;
}

type OverlayView = "overview" | "findings" | "detail" | "help";
type OverlayPhase = "loading" | "ready" | "running" | "cancelling";
type ScanKind = "changed" | "scan";
type OverlayAction = "changed" | "scan" | "findings" | "status" | "toggle" | "help";

interface ActionItem {
  readonly action: OverlayAction;
  readonly label: string;
}

type OverlayFinding = JscpdChangedFinding | JscpdPresentedFinding;

export function createJscpdOverlayLauncher(
  executor: JscpdCommandExecutor,
  options: JscpdOverlayLauncherOptions = {},
): JscpdOverlayLauncher {
  const changedFileCount = options.changedFileCount ?? (() => 0);
  const writeFallback =
    options.writeFallback ?? ((text: string) => process.stderr.write(`${text}\n`));
  return {
    async open(context) {
      if (context.mode !== "tui") {
        await openNonTuiFallback(executor, context, writeFallback);
        return;
      }
      await context.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new JscpdOverlayComponent({
            tui,
            theme,
            keybindings,
            executor,
            cwd: context.cwd,
            signal: context.signal,
            changedFileCount,
            done,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "80%",
            minWidth: 32,
            maxHeight: "80%",
            margin: 1,
          },
        },
      );
    },
  };
}

async function openNonTuiFallback(
  executor: JscpdCommandExecutor,
  context: ExtensionCommandContext,
  writeFallback: (text: string) => void,
): Promise<void> {
  const status = await safeExecute(executor, "status", context.cwd, context.signal);
  const text = [FALLBACK_PREFIX, executionMessage(status), FALLBACK_ACTIONS].join("\n");
  if (context.mode === "rpc") {
    context.ui.notify(text, statusLevel(status));
    return;
  }
  try {
    writeFallback(text);
  } catch {
    // A closed diagnostic stream must not make a non-TUI command fail.
  }
}

export class JscpdOverlayComponent {
  focused = false;
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #executor: JscpdCommandExecutor;
  readonly #cwd: string;
  readonly #outerSignal?: AbortSignal;
  readonly #changedFileCount: () => number;
  readonly #done: () => void;
  readonly #filter = new Input();
  #view: OverlayView = "overview";
  #phase: OverlayPhase = "loading";
  #status?: JscpdStatusResult;
  #result?: JscpdExecutionResult;
  #actionIndex = 0;
  #findingIndex = 0;
  #filtering = false;
  #active?: AbortController;
  #operationToken = 0;
  #lastScan?: ScanKind;
  #closeAfterRun = false;
  #disposed = false;
  #closed = false;

  constructor(options: JscpdOverlayComponentOptions) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#keybindings = options.keybindings;
    this.#executor = options.executor;
    this.#cwd = options.cwd;
    this.#outerSignal = options.signal;
    this.#changedFileCount = options.changedFileCount;
    this.#done = options.done;
    this.#outerSignal?.addEventListener("abort", this.#handleOuterAbort, { once: true });
    void this.#run("status");
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (this.#filtering) {
      this.#handleFilterInput(data);
      return;
    }
    if (this.#isBusy()) {
      this.#handleBusyInput(data);
      return;
    }
    if (this.#handleIdleGlobalInput(data)) return;
    if (this.#handleShortcut(data)) return;
    this.#handleNavigationInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (safeWidth < 4) return [truncateToWidth("jscpd", safeWidth, "")];
    const innerWidth = safeWidth - 2;
    const terminalRows = Math.max(1, this.#tui.terminal.rows || 10);
    const maxRows = Math.min(terminalRows, Math.max(5, Math.floor(terminalRows * 0.8)));
    const bodyRows = Math.max(1, maxRows - 3);
    const body = this.#bodyLines(innerWidth);
    const visibleBody = this.#visibleBody(body, bodyRows);
    const title = this.#phaseTitle();
    const footer = this.#footer();
    return [
      this.#borderLine("top", innerWidth, title),
      ...visibleBody.map((line) => this.#contentLine(line, innerWidth)),
      this.#contentLine(footer, innerWidth),
      this.#borderLine("bottom", innerWidth),
    ].slice(0, maxRows);
  }

  invalidate(): void {
    this.#filter.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#operationToken += 1;
    this.#active?.abort();
    this.#active = undefined;
    this.#outerSignal?.removeEventListener("abort", this.#handleOuterAbort);
  }

  #handleOuterAbort = (): void => {
    this.#closeAfterRun = true;
    if (this.#active) this.#cancel(true);
    else this.#close();
  };

  async #run(command: "status" | "changed" | "scan" | "on" | "off"): Promise<void> {
    if (this.#active || this.#disposed) return;
    const controller = new AbortController();
    const token = this.#beginOperation(command, controller);
    const result = await safeExecute(
      this.#executor,
      command,
      this.#cwd,
      this.#combinedSignal(controller.signal),
    );
    if (!this.#operationIsCurrent(token)) return;
    this.#active = undefined;
    this.#phase = "ready";
    if (this.#closeAfterRun) {
      this.#close();
      return;
    }
    this.#acceptResult(command, result);
    this.#renderNow();
  }

  #beginOperation(
    command: "status" | "changed" | "scan" | "on" | "off",
    controller: AbortController,
  ): number {
    const token = ++this.#operationToken;
    this.#active = controller;
    this.#phase = command === "status" && !this.#status ? "loading" : "running";
    if (command === "scan" || command === "changed") this.#lastScan = command;
    this.#renderNow();
    return token;
  }

  #operationIsCurrent(token: number): boolean {
    return !this.#disposed && token === this.#operationToken;
  }

  #acceptResult(
    command: "status" | "changed" | "scan" | "on" | "off",
    result: JscpdExecutionResult,
  ): void {
    if (command === "status") {
      if (result.status === "status") this.#status = result;
      else this.#result = result;
    }
    if (command === "changed" || command === "scan") {
      this.#result = result;
      this.#findingIndex = 0;
      this.#filtering = false;
      this.#filter.setValue("");
      this.#view = resultFindings(result).length > 0 ? "findings" : "overview";
    }
    if (command === "on" || command === "off") void this.#run("status");
  }

  #combinedSignal(owned: AbortSignal): AbortSignal {
    return this.#outerSignal ? AbortSignal.any([owned, this.#outerSignal]) : owned;
  }

  #cancel(closeAfterRun: boolean): void {
    if (!this.#active) {
      if (closeAfterRun) this.#close();
      return;
    }
    this.#closeAfterRun ||= closeAfterRun;
    this.#phase = "cancelling";
    this.#active.abort();
    this.#renderNow();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.#done();
  }

  #backOrClose(): void {
    if (this.#view === "overview") {
      this.#close();
      return;
    }
    if (this.#filtering) {
      this.#filtering = false;
      this.#filter.focused = false;
    }
    this.#view = this.#view === "detail" ? "findings" : "overview";
    this.#renderNow();
  }

  #isBusy(): boolean {
    return this.#phase !== "ready";
  }

  #handleBusyInput(data: string): void {
    if (this.#isCancel(data)) this.#cancel(false);
    else if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) this.#cancel(true);
  }

  #handleIdleGlobalInput(data: string): boolean {
    if (this.#isCancel(data)) {
      this.#backOrClose();
      return true;
    }
    if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.#close();
      return true;
    }
    if (matchesKey(data, "?")) {
      this.#view = "help";
      this.#renderNow();
      return true;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.#cyclePrimaryView();
      return true;
    }
    return false;
  }

  #handleNavigationInput(data: string): void {
    if (this.#isUp(data)) this.#move(-1);
    else if (this.#isDown(data)) this.#move(1);
    else if (this.#keybindings.matches(data, "tui.select.pageUp")) this.#move(-this.#pageSize());
    else if (this.#keybindings.matches(data, "tui.select.pageDown")) this.#move(this.#pageSize());
    else if (this.#keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "return"))
      this.#activate();
    else if (matchesKey(data, "/") && this.#view === "findings") this.#startFiltering();
  }

  #startFiltering(): void {
    this.#filtering = true;
    this.#filter.focused = this.focused;
    this.#renderNow();
  }

  #handleShortcut(data: string): boolean {
    const shortcut = overlayShortcut(data);
    return shortcut ? this.#activateShortcut(shortcut) : false;
  }

  #activateShortcut(shortcut: "c" | "s" | "r" | "o"): boolean {
    switch (shortcut) {
      case "r":
        void this.#run(this.#lastScan ?? "status");
        return true;
      case "o":
        return this.#runOverviewShortcut(this.#status?.mode === "disabled" ? "on" : "off");
      case "c":
        return this.#runScanShortcut("changed");
      case "s":
        return this.#runScanShortcut("scan");
    }
  }

  #runOverviewShortcut(command: "on" | "off"): boolean {
    if (this.#view !== "overview") return false;
    void this.#run(command);
    return true;
  }

  #runScanShortcut(command: ScanKind): boolean {
    if (this.#view !== "overview" || !this.#canScan()) return false;
    void this.#run(command);
    return true;
  }

  #move(delta: number): void {
    if (this.#view === "overview") {
      const count = this.#actions().length;
      this.#actionIndex = clamp(this.#actionIndex + delta, 0, Math.max(0, count - 1));
    } else if (this.#view === "findings") {
      const count = this.#filteredFindings().length;
      this.#findingIndex = clamp(this.#findingIndex + delta, 0, Math.max(0, count - 1));
    }
    this.#renderNow();
  }

  #activate(): void {
    if (this.#view === "overview") {
      const selected = this.#actions()[this.#actionIndex];
      if (selected) this.#activateAction(selected.action);
      return;
    }
    if (this.#view === "findings" && this.#filteredFindings()[this.#findingIndex]) {
      this.#view = "detail";
      this.#renderNow();
    }
  }

  #activateAction(action: OverlayAction): void {
    if (action === "changed" || action === "scan" || action === "status") void this.#run(action);
    else if (action === "findings") {
      this.#view = "findings";
      this.#renderNow();
    } else if (action === "toggle") {
      void this.#run(this.#status?.mode === "disabled" ? "on" : "off");
    } else {
      this.#view = "help";
      this.#renderNow();
    }
  }

  #cyclePrimaryView(): void {
    if (resultFindings(this.#result).length === 0) return;
    this.#view = this.#view === "findings" ? "overview" : "findings";
    this.#renderNow();
  }

  #handleFilterInput(data: string): void {
    if (this.#isCancel(data)) {
      this.#filtering = false;
      this.#filter.focused = false;
      this.#renderNow();
      return;
    }
    if (matchesKey(data, "return")) {
      this.#filtering = false;
      this.#filter.focused = false;
      this.#renderNow();
      return;
    }
    this.#filter.handleInput(data);
    const bounded = Array.from(this.#filter.getValue()).slice(0, FILTER_LIMIT).join("");
    if (bounded !== this.#filter.getValue()) this.#filter.setValue(bounded);
    this.#findingIndex = 0;
    this.#renderNow();
  }

  #actions(): readonly ActionItem[] {
    const actions: ActionItem[] = [];
    if (this.#canScan()) {
      actions.push(
        { action: "changed", label: "Check session changes" },
        { action: "scan", label: "Scan project" },
      );
    }
    if (resultFindings(this.#result).length > 0) {
      actions.push({
        action: "findings",
        label: `View ${resultFindings(this.#result).length} findings`,
      });
    }
    actions.push(
      { action: "status", label: "Refresh status" },
      {
        action: "toggle",
        label: this.#status?.mode === "disabled" ? "Enable for session" : "Disable for session",
      },
      { action: "help", label: "Help" },
    );
    this.#actionIndex = clamp(this.#actionIndex, 0, actions.length - 1);
    return actions;
  }

  #canScan(): boolean {
    return this.#status?.mode === "enabled" && this.#status.capability.status === "available";
  }

  #bodyLines(width: number): string[] {
    if (this.#phase !== "ready") return this.#runningLines();
    switch (this.#view) {
      case "overview":
        return this.#overviewLines();
      case "findings":
        return this.#findingLines(width);
      case "detail":
        return this.#detailLines();
      case "help":
        return this.#helpLines();
    }
  }

  #runningLines(): string[] {
    if (this.#phase === "cancelling") return ["Cancelling safely…", "Owned cleanup is bounded."];
    if (this.#phase === "loading") return ["Loading status…", "Esc cancels and closes safely."];
    const label = this.#lastScan === "scan" ? "Scanning project…" : "Checking session changes…";
    return [label, "Esc cancels; no source files are modified."];
  }

  #overviewLines(): string[] {
    const lines = [
      this.#statusLine(),
      this.#lastCheckLine(),
      `${this.#safeChangedCount()} session-changed files`,
    ];
    if (this.#result) lines.push(...executionMessage(this.#result).split("\n").slice(0, 2));
    lines.push("");
    this.#actions().forEach((item, index) => {
      lines.push(`${index === this.#actionIndex ? ">" : " "} ${item.label}`);
    });
    return lines;
  }

  #statusLine(): string {
    if (!this.#status) return "Status unavailable";
    const capability = this.#status.capability;
    const binary =
      capability.status === "available"
        ? `${capability.executable} ${capability.version} ready`
        : capability.status === "missing"
          ? "jscpd v5 not found"
          : `binary ${capability.status}`;
    return `${this.#status.mode} (${this.#status.modeSource}) | ${binary}`;
  }

  #lastCheckLine(): string {
    const last = this.#status?.lastCheck;
    if (!last || last.state === "never") return "Last check: never";
    if (last.state === "findings") return `Last check: ${last.clones} duplicate blocks`;
    return `Last check: ${last.state}`;
  }

  #findingLines(width: number): string[] {
    const findings = this.#filteredFindings();
    const lines: string[] = [];
    if (this.#filtering || this.#filter.getValue()) {
      const [input = ""] = this.#filter.render(Math.max(1, width - 8));
      lines.push(`Filter: ${input}`, "");
    }
    if (findings.length === 0) return [...lines, "No findings match this filter."];
    findings.forEach((finding, index) => {
      const [first, second] = finding.occurrences;
      const marker = index === this.#findingIndex ? ">" : " ";
      lines.push(`${marker} ${index + 1}. ${location(first)} <-> ${location(second)}`);
      lines.push(`    ${finding.lines} lines | ${finding.tokens} tokens | ${finding.format}`);
    });
    const omitted = resultOmitted(this.#result);
    if (omitted > 0) lines.push(`${omitted} additional findings omitted by the display limit.`);
    const ambiguous = resultAmbiguous(this.#result);
    if (ambiguous > 0) {
      lines.push(`${ambiguous} duplicate blocks could not be classified safely.`);
    }
    return lines;
  }

  #detailLines(): string[] {
    const finding = this.#filteredFindings()[this.#findingIndex];
    if (!finding) return ["This finding is no longer available.", "Esc returns to Overview."];
    const [first, second] = finding.occurrences;
    return [
      `Duplicate block ${this.#findingIndex + 1} of ${this.#filteredFindings().length}`,
      relation(first),
      location(first),
      "matches",
      relation(second),
      location(second),
      `${finding.lines} lines | ${finding.tokens} tokens | ${finding.format}`,
      "",
      "Duplication may be intentional; inspect both locations before changing code.",
      "Use r to rescan after an ordinary user-approved refactor.",
    ];
  }

  #helpLines(): string[] {
    return [
      "Up/Down or j/k: move selection",
      "Enter: select or open detail",
      "Tab: Overview / Findings",
      "/: filter findings by path or format",
      "c: check changes | s: scan project | r: rerun",
      "o: enable/disable this session | ?: help",
      "Esc: back/close/cancel | q or Ctrl+C: close",
      "",
      "Advisory only: the overlay never edits source or jscpd configuration.",
      "If missing, install jscpd v5 yourself and ensure jscpd or cpd is on PATH.",
      "Use explicit /jscpd scan <target> for scoped paths.",
    ];
  }

  #filteredFindings(): readonly OverlayFinding[] {
    const findings = resultFindings(this.#result).slice(0, OVERLAY_FINDING_LIMIT);
    const query = this.#filter.getValue().trim().toLowerCase();
    if (!query) return findings;
    return findings.filter((finding) =>
      [finding.format, ...finding.occurrences.map(({ path }) => path)].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }

  #visibleBody(lines: string[], count: number): string[] {
    if (lines.length <= count)
      return [...lines, ...Array(Math.max(0, count - lines.length)).fill("")];
    const selected = Math.max(
      0,
      lines.findIndex((line) => line.startsWith(">")),
    );
    if (this.#view === "overview") {
      const fixed = lines.slice(0, Math.min(3, count));
      const remaining = count - fixed.length;
      const start = clamp(
        selected - Math.floor(remaining / 2),
        fixed.length,
        Math.max(fixed.length, lines.length - remaining),
      );
      return [...fixed, ...lines.slice(start, start + remaining)];
    }
    const start = clamp(selected - Math.floor(count / 2), 0, Math.max(0, lines.length - count));
    return lines.slice(start, start + count);
  }

  #phaseTitle(): string {
    if (this.#view === "help") return "pi-jscpd help";
    if (this.#view === "detail") return "pi-jscpd finding";
    if (this.#view === "findings") return "pi-jscpd findings";
    return "pi-jscpd";
  }

  #footer(): string {
    if (this.#phase !== "ready") return "Esc cancel | q cancel and close";
    if (this.#filtering) return "Type to filter | Enter apply | Esc cancel filter";
    return "Up/Down move | Enter select | ? help | Esc back/close";
  }

  #borderLine(kind: "top" | "bottom", width: number, title = ""): string {
    if (kind === "bottom") return this.#theme.fg("border", `╰${"─".repeat(width)}╯`);
    const boundedTitle = truncateToWidth(` ${title} `, width, "");
    const remaining = Math.max(0, width - visibleWidth(boundedTitle));
    return `${this.#theme.fg("border", "╭")}${this.#theme.fg("accent", boundedTitle)}${this.#theme.fg("border", `${"─".repeat(remaining)}╮`)}`;
  }

  #contentLine(content: string, width: number): string {
    const bounded = truncateToWidth(content, width, "…", true);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(bounded)));
    return `${this.#theme.fg("border", "│")}${bounded}${padding}${this.#theme.fg("border", "│")}`;
  }

  #isCancel(data: string): boolean {
    return this.#keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape");
  }

  #isUp(data: string): boolean {
    return this.#keybindings.matches(data, "tui.select.up") || matchesKey(data, "k");
  }

  #isDown(data: string): boolean {
    return this.#keybindings.matches(data, "tui.select.down") || matchesKey(data, "j");
  }

  #pageSize(): number {
    return Math.max(1, Math.floor((this.#tui.terminal.rows || 10) * 0.4));
  }

  #safeChangedCount(): number {
    try {
      return Math.max(0, this.#changedFileCount());
    } catch {
      return 0;
    }
  }

  #renderNow(): void {
    if (!this.#disposed) this.#tui.requestRender();
  }
}

async function safeExecute(
  executor: JscpdCommandExecutor,
  command: JscpdCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<JscpdExecutionResult> {
  try {
    return await executor.execute({ command, args: [] }, { cwd, signal });
  } catch {
    return Object.freeze({
      status: "failed",
      reason: "process-failed",
      message: "The jscpd request failed safely; no source files were changed.",
    });
  }
}

function resultFindings(result?: JscpdExecutionResult): readonly OverlayFinding[] {
  if (result?.status === "changed" || result?.status === "completed") return result.findings;
  return [];
}

function resultOmitted(result?: JscpdExecutionResult): number {
  if (result?.status === "changed" || result?.status === "completed") {
    return result.omittedFindings;
  }
  return 0;
}

function resultAmbiguous(result?: JscpdExecutionResult): number {
  return result?.status === "changed" ? result.ambiguousFindings : 0;
}

function location(occurrence: OverlayFinding["occurrences"][number]): string {
  return `${occurrence.path}:${occurrence.startLine}-${occurrence.endLine}`;
}

function relation(occurrence: OverlayFinding["occurrences"][number]): string {
  return "relation" in occurrence
    ? occurrence.relation === "new-session"
      ? "new in this session"
      : "existing match"
    : "current location";
}

function executionMessage(result: JscpdExecutionResult): string {
  return "terminalMessage" in result ? result.terminalMessage : result.message;
}

function statusLevel(result: JscpdExecutionResult): "info" | "warning" {
  return result.status === "status" ? "info" : "warning";
}

function overlayShortcut(data: string): "c" | "s" | "r" | "o" | undefined {
  return (["c", "s", "r", "o"] as const).find((shortcut) => matchesKey(data, shortcut));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
