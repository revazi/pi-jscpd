import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  jscpdFindingDetailLines,
  jscpdFindingGuidance,
  jscpdFindingLocations,
} from "./finding-presentation.js";
import type {
  JscpdChangedFinding,
  JscpdCommand,
  JscpdCommandInvocation,
  JscpdExecutionContext,
  JscpdExecutionResult,
  JscpdPresentedFinding,
  JscpdStatusResult,
} from "./types.js";

/** Promise execution is confined to the Pi UI adapter, never a domain service. */
export interface JscpdOverlayExecutor {
  execute(
    invocation: JscpdCommandInvocation,
    context: JscpdExecutionContext,
  ): Promise<JscpdExecutionResult>;
}

const FILTER_LIMIT = 256;
const JSCPD_OVERLAY_FINDING_LIMIT = 100;
const OVERLAY_FINDING_PAGE_SIZE = 10;
const PROMPT_FINDING_LIMIT = 20;
const PROMPT_CHARACTER_LIMIT = 12_000;
const FALLBACK_ACTIONS = "Use /jscpd changed, /jscpd scan, /jscpd off|on, or /jscpd help.";
const FALLBACK_PREFIX = "The /jscpd overlay requires Pi TUI mode.";

export interface JscpdOverlayLauncher {
  open(context: ExtensionCommandContext): Promise<void>;
}

export interface JscpdOverlayLauncherOptions {
  readonly changedFileCount?: () => number;
  readonly writeFallback?: (text: string) => void;
}

export interface JscpdOverlayPromptResult {
  readonly type: "prompt";
  readonly prompt: string;
  readonly findingCount: number;
  readonly omittedSelectionCount: number;
}

export interface JscpdOverlayComponentOptions {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly executor: JscpdOverlayExecutor;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly changedFileCount: () => number;
  readonly done: (result: JscpdOverlayPromptResult | null) => void;
}

type OverlayView = "overview" | "findings" | "help";
type OverlayPhase = "loading" | "ready" | "running" | "cancelling";
type ScanKind = "changed" | "scan";
type RunnableCommand = "status" | "changed" | "scan" | "on" | "off";
type OverlayAction = "changed" | "scan" | "findings" | "status" | "toggle" | "help";
type OverlayFinding = JscpdChangedFinding | JscpdPresentedFinding;

interface ActionItem {
  readonly action: OverlayAction;
  readonly label: string;
  readonly description: string;
}

interface FindingEntry {
  readonly id: number;
  readonly ordinal: number;
  readonly finding: OverlayFinding;
}

export function createJscpdOverlayLauncher(
  executor: JscpdOverlayExecutor,
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
      const result = await context.ui.custom<JscpdOverlayPromptResult | null>(
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
            width: "90%",
            minWidth: 50,
            maxHeight: "95%",
          },
        },
      );
      if (result?.type !== "prompt") return;
      context.ui.setEditorText(result.prompt);
      const omitted = result.omittedSelectionCount
        ? ` ${counted(result.omittedSelectionCount, "additional selection")} omitted by the prompt limit.`
        : "";
      context.ui.notify(
        `Loaded ${counted(result.findingCount, "jscpd duplicate block")} into the editor. Add comments, then submit when ready.${omitted}`,
        "info",
      );
    },
  };
}

async function openNonTuiFallback(
  executor: JscpdOverlayExecutor,
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

export class JscpdOverlayComponent implements Component, Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #executor: JscpdOverlayExecutor;
  readonly #cwd: string;
  readonly #outerSignal?: AbortSignal;
  readonly #changedFileCount: () => number;
  readonly #done: (result: JscpdOverlayPromptResult | null) => void;
  readonly #filter = new Input();
  #focused = false;
  #view: OverlayView = "overview";
  #phase: OverlayPhase = "loading";
  #status?: JscpdStatusResult;
  #result?: JscpdExecutionResult;
  #actionIndex = 0;
  #findingIndex = 0;
  #scrollStart = 0;
  #revealedFindingCount = OVERLAY_FINDING_PAGE_SIZE;
  #expandedFinding?: number;
  readonly #markedFindings = new Set<number>();
  #filtering = false;
  #searchBeforeEdit = "";
  #active?: AbortController;
  #activeCommand?: RunnableCommand;
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

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#filter.focused = value && this.#filtering;
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
    if (this.#handleViewShortcut(data)) return;
    this.#handleNavigationInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.#tui.terminal.rows || 10);
    const maxRows = Math.max(
      1,
      Math.min(terminalRows, Math.max(5, Math.floor(terminalRows * 0.95))),
    );
    if (safeWidth < 4 || maxRows < 4) {
      return [truncateToWidth(`pi-jscpd · ${this.#compactTitle()}`, safeWidth, "")].slice(
        0,
        maxRows,
      );
    }

    const innerWidth = safeWidth - 4;
    const bodyRows = Math.max(1, maxRows - 4);
    const body = this.#bodyLines(innerWidth, bodyRows).slice(0, bodyRows);
    return [
      this.#topBorder(safeWidth, this.#headerTitle()),
      ...body.map((line) => this.#frame(line, safeWidth)),
      this.#separator(safeWidth),
      this.#frame(this.#footer(), safeWidth),
      this.#bottomBorder(safeWidth),
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
    this.#activeCommand = undefined;
    this.#outerSignal?.removeEventListener("abort", this.#handleOuterAbort);
  }

  #handleOuterAbort = (): void => {
    this.#closeAfterRun = true;
    if (this.#active) this.#cancel(true);
    else this.#close();
  };

  async #run(command: RunnableCommand): Promise<void> {
    if (this.#active || this.#disposed) return;
    const controller = new AbortController();
    const token = this.#beginOperation(command, controller);
    const result = await safeExecute(
      this.#executor,
      command,
      this.#cwd,
      this.#combinedSignal(controller.signal),
      JSCPD_OVERLAY_FINDING_LIMIT,
    );
    if (!this.#operationIsCurrent(token)) return;
    this.#active = undefined;
    this.#activeCommand = undefined;
    this.#phase = "ready";
    if (this.#closeAfterRun) {
      this.#close();
      return;
    }
    this.#acceptResult(command, result);
    this.#renderNow();
  }

  #beginOperation(command: RunnableCommand, controller: AbortController): number {
    const token = ++this.#operationToken;
    this.#active = controller;
    this.#activeCommand = command;
    this.#phase = command === "status" && !this.#status ? "loading" : "running";
    if (command === "scan" || command === "changed") this.#lastScan = command;
    this.#renderNow();
    return token;
  }

  #operationIsCurrent(token: number): boolean {
    return !this.#disposed && token === this.#operationToken;
  }

  #acceptResult(command: RunnableCommand, result: JscpdExecutionResult): void {
    if (command === "status") {
      if (result.status === "status") this.#status = result;
      else this.#result = result;
    }
    if (command === "changed" || command === "scan") {
      this.#result = result;
      this.#findingIndex = 0;
      this.#scrollStart = 0;
      this.#revealedFindingCount = OVERLAY_FINDING_PAGE_SIZE;
      this.#expandedFinding = undefined;
      this.#markedFindings.clear();
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

  #close(result: JscpdOverlayPromptResult | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.#done(result);
  }

  #backOrClose(): void {
    if (this.#view === "overview") {
      this.#close();
      return;
    }
    this.#view = "overview";
    this.#expandedFinding = undefined;
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
    if (matchesKey(data, "shift+tab") && this.#view !== "overview") {
      this.#view = "overview";
      this.#renderNow();
      return true;
    }
    if (matchesKey(data, "tab") && this.#view === "overview") {
      if (resultFindings(this.#result).length > 0) {
        this.#view = "findings";
        this.#renderNow();
      }
      return true;
    }
    return false;
  }

  #handleViewShortcut(data: string): boolean {
    if (this.#view === "overview") return this.#handleOverviewShortcut(data);
    if (this.#view === "findings") return this.#handleFindingsShortcut(data);
    return false;
  }

  #handleOverviewShortcut(data: string): boolean {
    if (matchesKey(data, "r")) {
      void this.#run(this.#lastScan ?? "status");
      return true;
    }
    if (matchesKey(data, "o")) {
      void this.#run(this.#status?.mode === "disabled" ? "on" : "off");
      return true;
    }
    if (matchesKey(data, "c") && this.#canScan()) {
      void this.#run("changed");
      return true;
    }
    if (matchesKey(data, "s") && this.#canScan()) {
      void this.#run("scan");
      return true;
    }
    return false;
  }

  #handleFindingsShortcut(data: string): boolean {
    if (matchesKey(data, "r")) {
      void this.#run(this.#lastScan ?? "scan");
      return true;
    }
    if (data === "L") {
      this.#loadNextFindings();
      return true;
    }
    if (matchesKey(data, "/")) {
      this.#startFiltering();
      return true;
    }
    if (matchesKey(data, "x")) {
      this.#clearFilter();
      return true;
    }
    if (matchesKey(data, "s") || matchesKey(data, "tab")) {
      this.#toggleMarked();
      return true;
    }
    if (data === "A") {
      this.#toggleAllVisible();
      return true;
    }
    if (matchesKey(data, "c")) {
      this.#clearMarked();
      return true;
    }
    if (matchesKey(data, "e") || matchesKey(data, "a")) {
      this.#finishWithPrompt();
      return true;
    }
    return false;
  }

  #handleNavigationInput(data: string): void {
    if (this.#isUp(data)) this.#move(-1);
    else if (this.#isDown(data)) this.#move(1);
    else if (this.#keybindings.matches(data, "tui.select.pageUp")) this.#move(-this.#pageSize());
    else if (this.#keybindings.matches(data, "tui.select.pageDown")) this.#move(this.#pageSize());
    else if (matchesKey(data, "home")) this.#moveToBoundary("start");
    else if (matchesKey(data, "end")) this.#moveToBoundary("end");
    else if (
      this.#keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, "return") ||
      matchesKey(data, "space") ||
      matchesKey(data, "right") ||
      matchesKey(data, "l")
    )
      this.#activate();
    else if (matchesKey(data, "left") || matchesKey(data, "h")) this.#collapseCurrent();
  }

  #startFiltering(): void {
    this.#searchBeforeEdit = this.#filter.getValue();
    this.#filtering = true;
    this.#filter.focused = this.#focused;
    this.#renderNow();
  }

  #handleFilterInput(data: string): void {
    if (this.#isCancel(data)) {
      this.#filter.setValue(this.#searchBeforeEdit);
      this.#finishFilterEdit();
      return;
    }
    if (matchesKey(data, "return")) {
      this.#finishFilterEdit();
      return;
    }
    if (matchesKey(data, "ctrl+u")) this.#filter.setValue("");
    else this.#filter.handleInput(data);
    const bounded = Array.from(this.#filter.getValue()).slice(0, FILTER_LIMIT).join("");
    if (bounded !== this.#filter.getValue()) this.#filter.setValue(bounded);
    this.#resetFindingViewport();
    this.#renderNow();
  }

  #finishFilterEdit(): void {
    this.#filtering = false;
    this.#filter.focused = false;
    this.#resetFindingViewport();
    this.#renderNow();
  }

  #clearFilter(): void {
    if (!this.#filter.getValue()) return;
    this.#filter.setValue("");
    this.#resetFindingViewport();
    this.#renderNow();
  }

  #resetFindingViewport(): void {
    this.#findingIndex = 0;
    this.#scrollStart = 0;
    this.#expandedFinding = undefined;
  }

  #actions(): readonly ActionItem[] {
    const actions: ActionItem[] = [];
    if (this.#canScan()) {
      actions.push(
        {
          action: "changed",
          label: "Check session changes",
          description: "new duplicate blocks in tracked edits",
        },
        { action: "scan", label: "Scan project", description: "all current duplicate blocks" },
      );
    }
    if (resultFindings(this.#result).length > 0) {
      actions.push({
        action: "findings",
        label: `View ${counted(resultFindings(this.#result).length, "finding")}`,
        description: "browse the current in-memory result",
      });
    }
    actions.push(
      {
        action: "status",
        label: "Refresh status",
        description: "probe readiness without scanning",
      },
      {
        action: "toggle",
        label: this.#status?.mode === "disabled" ? "Enable for session" : "Disable for session",
        description: "session only; no configuration write",
      },
      { action: "help", label: "Help", description: "controls and safe next steps" },
    );
    this.#actionIndex = clamp(this.#actionIndex, 0, actions.length - 1);
    return actions;
  }

  #canScan(): boolean {
    return this.#status?.mode === "enabled" && this.#status.capability.status === "available";
  }

  #move(delta: number): void {
    if (this.#view === "overview") {
      const count = this.#actions().length;
      this.#actionIndex = clamp(this.#actionIndex + delta, 0, Math.max(0, count - 1));
    } else if (this.#view === "findings") {
      let visible = this.#filteredEntries();
      const target = this.#findingIndex + delta;
      if (delta > 0 && target >= visible.length && this.#hasMoreCachedFindings()) {
        this.#revealNextFindingPage();
        visible = this.#filteredEntries();
      }
      this.#findingIndex = clamp(target, 0, Math.max(0, visible.length - 1));
    }
    this.#renderNow();
  }

  #moveToBoundary(boundary: "start" | "end"): void {
    if (this.#view === "overview") {
      this.#actionIndex = boundary === "start" ? 0 : Math.max(0, this.#actions().length - 1);
    } else if (this.#view === "findings") {
      this.#findingIndex =
        boundary === "start" ? 0 : Math.max(0, this.#filteredEntries().length - 1);
    }
    this.#renderNow();
  }

  #activate(): void {
    if (this.#view === "overview") {
      const selected = this.#actions()[this.#actionIndex];
      if (selected) this.#activateAction(selected.action);
      return;
    }
    if (this.#view === "findings") this.#toggleExpanded();
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

  #toggleExpanded(): void {
    const current = this.#currentEntry();
    if (!current) return;
    this.#expandedFinding = this.#expandedFinding === current.id ? undefined : current.id;
    this.#renderNow();
  }

  #collapseCurrent(): void {
    const current = this.#currentEntry();
    if (!current || this.#expandedFinding !== current.id) return;
    this.#expandedFinding = undefined;
    this.#renderNow();
  }

  #toggleMarked(): void {
    const current = this.#currentEntry();
    if (!current) return;
    if (this.#markedFindings.has(current.id)) this.#markedFindings.delete(current.id);
    else this.#markedFindings.add(current.id);
    this.#renderNow();
  }

  #toggleAllVisible(): void {
    const visible = this.#filteredEntries();
    if (visible.length === 0) return;
    const shouldMark = !visible.every((entry) => this.#markedFindings.has(entry.id));
    for (const entry of visible) {
      if (shouldMark) this.#markedFindings.add(entry.id);
      else this.#markedFindings.delete(entry.id);
    }
    this.#renderNow();
  }

  #clearMarked(): void {
    if (this.#markedFindings.size === 0) return;
    this.#markedFindings.clear();
    this.#renderNow();
  }

  #finishWithPrompt(): void {
    const selection = this.#selection();
    if (selection.length === 0) return;
    const prompt = buildJscpdOverlayPrompt(
      selection.map(({ finding }) => finding),
      this.#result?.status === "changed" ? "changed" : "project",
    );
    this.#close({
      type: "prompt",
      prompt: prompt.prompt,
      findingCount: prompt.findingCount,
      omittedSelectionCount: selection.length - prompt.findingCount,
    });
  }

  #selection(): readonly FindingEntry[] {
    if (this.#markedFindings.size > 0) {
      return this.#entries().filter((entry) => this.#markedFindings.has(entry.id));
    }
    const current = this.#currentEntry();
    return current ? [current] : [];
  }

  #currentEntry(): FindingEntry | undefined {
    return this.#filteredEntries()[this.#findingIndex];
  }

  #entries(): readonly FindingEntry[] {
    return this.#cachedEntries().slice(0, this.#revealedFindingCount);
  }

  #cachedEntries(): readonly FindingEntry[] {
    return resultFindings(this.#result)
      .slice(0, JSCPD_OVERLAY_FINDING_LIMIT)
      .map((finding, index) => ({ id: index, ordinal: index + 1, finding }));
  }

  #hasMoreCachedFindings(): boolean {
    return this.#entries().length < this.#cachedEntries().length;
  }

  #revealNextFindingPage(): void {
    this.#revealedFindingCount = Math.min(
      this.#revealedFindingCount + OVERLAY_FINDING_PAGE_SIZE,
      this.#cachedEntries().length,
    );
  }

  #loadNextFindings(): void {
    if (!this.#hasMoreCachedFindings()) return;
    this.#revealNextFindingPage();
    this.#renderNow();
  }

  #filteredEntries(): readonly FindingEntry[] {
    const entries = this.#entries();
    const query = this.#filter.getValue().trim().toLocaleLowerCase();
    if (!query) return entries;
    return entries.filter(({ finding }) =>
      [finding.format, ...finding.occurrences.map(({ path }) => path)].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }

  #bodyLines(width: number, rowLimit: number): string[] {
    if (this.#phase !== "ready") return this.#runningLines();
    switch (this.#view) {
      case "overview":
        return this.#overviewLines(width, rowLimit);
      case "findings":
        return this.#findingLines(width, rowLimit);
      case "help":
        return this.#helpLines().slice(0, rowLimit);
    }
  }

  #runningLines(): string[] {
    if (this.#phase === "cancelling") return ["Cancelling safely…", "Owned cleanup is bounded."];
    if (this.#phase === "loading") return ["Loading status…", "Esc cancels and closes safely."];
    const label =
      this.#activeCommand === "scan"
        ? "Scanning project…"
        : this.#activeCommand === "changed"
          ? "Checking session changes…"
          : this.#activeCommand === "status"
            ? "Refreshing status…"
            : "Updating session mode…";
    return [label, "Esc cancels; no source files are modified."];
  }

  #overviewLines(width: number, rowLimit: number): string[] {
    const intro = [
      this.#statusLine(),
      this.#configurationLine(),
      this.#lastCheckLine(),
      ...(this.#result ? [this.#resultSummaryLine()] : []),
    ];
    const actions = this.#actions().map((item, index) => this.#actionLine(item, index, width));
    if (intro.length + actions.length + 1 <= rowLimit) return [...intro, "", ...actions];

    const introCount = Math.min(intro.length, Math.max(1, rowLimit - 1));
    const actionRows = Math.max(1, rowLimit - introCount);
    const start = clamp(
      this.#actionIndex - Math.floor(actionRows / 2),
      0,
      Math.max(0, actions.length - actionRows),
    );
    return [...intro.slice(0, introCount), ...actions.slice(start, start + actionRows)];
  }

  #actionLine(item: ActionItem, index: number, width: number): string {
    const selected = index === this.#actionIndex;
    const marker = selected ? this.#theme.fg("accent", "❯") : this.#theme.fg("dim", " ");
    const icon = selected ? this.#theme.fg("accent", "◆") : this.#theme.fg("dim", "◇");
    const label = selected ? this.#theme.bold(item.label) : item.label;
    const raw = `${marker} ${icon} ${label}${this.#theme.fg("dim", ` · ${item.description}`)}`;
    return selected ? this.#theme.bg("selectedBg", truncateToWidth(raw, width)) : raw;
  }

  #statusLine(): string {
    if (!this.#status) return this.#theme.fg("warning", "● Status unavailable");
    const capability = this.#status.capability;
    const modeIcon = this.#status.mode === "enabled" ? "✓" : "○";
    const modeColor = this.#status.mode === "enabled" ? "success" : "warning";
    const binary =
      capability.status === "available"
        ? `${capability.executable} ${capability.version}${capability.source === "bundled" ? " bundled" : ""}`
        : capability.status === "missing"
          ? "jscpd v5 not found"
          : `binary ${capability.status}`;
    return `${this.#theme.fg(modeColor, modeIcon)} ${this.#theme.bold(this.#status.mode)}${this.#theme.fg("dim", ` (${this.#status.modeSource})`)}  ${this.#pill(binary, capability.status === "available" ? "accent" : "warning")}`;
  }

  #configurationLine(): string {
    if (!this.#status) return "Configuration unavailable";
    const config =
      this.#status.configSource === "defaults"
        ? "built-in defaults"
        : `${this.#status.configSource} configuration`;
    const coexistence = this.#status.fallowAutomatic
      ? ` · Fallow overlap: jscpd automatic ${this.#status.fallowAutomatic}`
      : "";
    return `${this.#theme.fg("muted", "Configuration")} ${config}${this.#theme.fg("dim", ` · ${this.#safeChangedCount()} session-changed files${coexistence}`)}`;
  }

  #lastCheckLine(): string {
    const last = this.#status?.lastCheck;
    let value = "never";
    if (last?.state === "findings") value = counted(last.clones, "duplicate block");
    else if (last) value = last.state;
    return `${this.#theme.fg("muted", "Last check")} ${this.#theme.fg(last?.state === "failed" ? "warning" : "text", value)}`;
  }

  #resultSummaryLine(): string {
    if (!this.#result) return "";
    const first = executionMessage(this.#result).split("\n")[0] ?? "";
    return `${this.#theme.fg("accent", "Current result")} ${first}`;
  }

  #findingLines(width: number, rowLimit: number): string[] {
    const visible = this.#filteredEntries();
    const prelude = [this.#findingContextLine(visible.length)];
    if (this.#hasMoreCachedFindings()) {
      const remaining = this.#cachedEntries().length - this.#entries().length;
      prelude.push(
        this.#theme.fg(
          "accent",
          `Load next ${Math.min(OVERLAY_FINDING_PAGE_SIZE, remaining)} / L · ${counted(remaining, "cached finding")} remain`,
        ),
      );
    }
    if (this.#filtering || this.#filter.getValue()) prelude.push(this.#filterLine(width));
    if (visible.length === 0)
      return [...prelude, this.#theme.fg("warning", "No findings match the active search.")];

    const current = visible[this.#findingIndex];
    const expanded = current && this.#expandedFinding === current.id;
    const detail = expanded ? this.#findingDetailLines(current, width) : [];
    const availableRows = Math.max(1, rowLimit - prelude.length);
    const rowsPerFinding = width < 64 ? 3 : 1;
    const detailRows = Math.min(detail.length, Math.max(0, availableRows - rowsPerFinding - 1));
    const listSlots = Math.max(rowsPerFinding, availableRows - detailRows);
    const visibleRows = Math.max(1, Math.floor((listSlots - 2) / rowsPerFinding));
    this.#ensureFindingVisible(visibleRows, visible.length);
    const start = this.#scrollStart;
    const end = Math.min(visible.length, start + visibleRows);
    const rows: string[] = [...prelude];
    if (start > 0) rows.push(this.#theme.fg("dim", `… ${counted(start, "earlier finding")}`));
    for (let index = start; index < end; index += 1) {
      const entry = visible[index];
      if (!entry) continue;
      rows.push(...this.#findingRows(entry, index, width));
      if (expanded && entry.id === current.id) rows.push(...detail.slice(0, detailRows));
    }
    if (end < visible.length) {
      rows.push(this.#theme.fg("dim", `… ${counted(visible.length - end, "later finding")}`));
    }
    return rows.slice(0, rowLimit);
  }

  #findingContextLine(filteredCount: number): string {
    const available = this.#entries().length;
    const retained = this.#cachedEntries().length;
    const total = resultTotal(this.#result);
    const omitted = resultOmitted(this.#result);
    const ambiguous = resultAmbiguous(this.#result);
    const parts = [
      `${filteredCount === available ? available : `${filteredCount}/${available}`} shown`,
      retained > available ? `${retained} retained` : undefined,
      `${total} total`,
      omitted > 0
        ? resultHasOverlayCache(this.#result)
          ? `${omitted} beyond overlay cache`
          : `${omitted} not retained (display limit)`
        : undefined,
      ambiguous > 0 ? `${ambiguous} unclassified` : undefined,
    ].filter(Boolean);
    return parts
      .map((part, index) => this.#pill(part as string, index === 0 ? "accent" : "muted"))
      .join(this.#theme.fg("dim", " "));
  }

  #filterLine(width: number): string {
    const rendered = this.#filter.render(Math.max(1, width - 9))[0] ?? "";
    return `${this.#theme.fg("accent", "Search")} ${rendered}`;
  }

  #findingRows(entry: FindingEntry, visibleIndex: number, width: number): string[] {
    const selected = visibleIndex === this.#findingIndex;
    const marked = this.#markedFindings.has(entry.id);
    const expanded = this.#expandedFinding === entry.id;
    const marker = selected ? this.#theme.fg("accent", "❯") : this.#theme.fg("dim", " ");
    const check = marked ? this.#theme.fg("success", "☑") : this.#theme.fg("dim", "☐");
    const disclosure = expanded ? this.#theme.fg("warning", "▾") : this.#theme.fg("accent", "▸");
    const [first, second] = jscpdFindingLocations(entry.finding);
    const metadata = `${entry.finding.lines}L/${entry.finding.tokens}T ${entry.finding.format}`;
    if (width < 64) {
      return [
        `${marker} ${check} ${disclosure} ${this.#theme.bold(`Duplicate ${entry.ordinal}`)}${this.#theme.fg("dim", ` · ${metadata}`)}`,
        `      ${this.#relationMark(first.label)} ${truncateToWidth(first.text, Math.max(1, width - 8))}`,
        `      ${this.#relationMark(second.label)} ${truncateToWidth(second.text, Math.max(1, width - 8))}`,
      ].map((line) =>
        selected ? this.#theme.bg("selectedBg", truncateToWidth(line, width)) : line,
      );
    }
    const fixedWidth = 20 + visibleWidth(metadata);
    const locationWidth = Math.max(3, Math.floor((width - fixedWidth) / 2));
    const firstText = middleTruncate(first.text, locationWidth);
    const secondText = middleTruncate(second.text, locationWidth);
    const raw = `${marker} ${check} ${disclosure} ${this.#relationMark(first.label)} ${firstText}${this.#theme.fg("dim", " ↔ ")}${this.#relationMark(second.label)} ${secondText}${this.#theme.fg("dim", ` · ${metadata}`)}`;
    const bounded = truncateToWidth(raw, width);
    return [selected ? this.#theme.bg("selectedBg", bounded) : bounded];
  }

  #relationMark(label: string): string {
    if (label === "new in this session") return this.#theme.fg("success", "N");
    if (label === "existing match") return this.#theme.fg("muted", "E");
    return this.#theme.fg("accent", "C");
  }

  #findingDetailLines(entry: FindingEntry, width: number): string[] {
    const total = resultTotal(this.#result);
    const scope = this.#result?.status === "changed" ? "changed" : "project";
    const [heading, first, second, metadata] = jscpdFindingDetailLines(
      entry.finding,
      entry.ordinal,
      total,
    );
    const context = [
      resultOmitted(this.#result) > 0
        ? resultHasOverlayCache(this.#result)
          ? `${counted(resultOmitted(this.#result), "additional finding")} exceed the 100-finding overlay cache.`
          : `${counted(resultOmitted(this.#result), "additional finding")} were not retained by the configured display limit.`
        : undefined,
      resultAmbiguous(this.#result) > 0
        ? `${counted(resultAmbiguous(this.#result), "duplicate block")} could not be classified safely.`
        : undefined,
      resultVerification(this.#result)?.message,
    ].filter(Boolean) as string[];
    return [
      this.#theme.fg("accent", `    ${heading}`),
      ...wrapTextWithAnsi(this.#theme.fg("text", `    ${first}`), width),
      ...wrapTextWithAnsi(this.#theme.fg("text", `    ${second}`), width),
      this.#theme.fg("muted", `    ${metadata}`),
      ...context.flatMap((line) => wrapTextWithAnsi(this.#theme.fg("dim", `    ${line}`), width)),
      ...jscpdFindingGuidance(scope)
        .slice(0, 2)
        .flatMap((line) => wrapTextWithAnsi(this.#theme.fg("dim", `    ${line}`), width)),
    ];
  }

  #ensureFindingVisible(listHeight: number, visibleCount: number): void {
    if (this.#findingIndex < this.#scrollStart) this.#scrollStart = this.#findingIndex;
    if (this.#findingIndex >= this.#scrollStart + listHeight) {
      this.#scrollStart = this.#findingIndex - listHeight + 1;
    }
    this.#scrollStart = clamp(this.#scrollStart, 0, Math.max(0, visibleCount - listHeight));
  }

  #helpLines(): string[] {
    return [
      `${this.#pill("↑↓/jk", "accent")} navigate  ${this.#pill("home/end", "muted")} boundaries  ${this.#pill("pgup/pgdn", "muted")} page`,
      `${this.#pill("enter/space/→/l", "accent")} expand  ${this.#pill("←/h", "muted")} collapse`,
      `${this.#pill("/", "accent")} search paths/format  ${this.#pill("x", "muted")} clear search  ${this.#pill("L", "muted")} load next 10`,
      `${this.#pill("s/tab", "accent")} select  ${this.#pill("A", "muted")} all shown  ${this.#pill("c", "muted")} clear selected`,
      `${this.#pill("e/a", "accent")} load selected findings into the editor  ${this.#pill("r", "muted")} rescan`,
      `${this.#pill("shift+tab/esc", "muted")} overview  ${this.#pill("q/ctrl+c", "muted")} close`,
      "",
      "Overview shortcuts: c checks session changes, s scans the project, o toggles this session, and r repeats the last scan or refreshes status.",
      "Search is a bounded, case-insensitive literal match over both paths and format.",
      "Loading findings only prefills Pi's editor. It never submits a prompt or changes source/configuration.",
      "Duplication is advisory and may be intentional. Inspect both locations before changing code.",
      "After normal edits and tests, rescan to compare with the prior matching explicit check.",
      "For intentional duplication, update normal jscpd ignore/exclusion policy through the ordinary workflow.",
      "Use /jscpd scan <target ...> for scoped paths. Reinstall pi-jscpd if the bundled analyzer is missing.",
    ];
  }

  #headerTitle(): string {
    const brand = `${this.#theme.fg("accent", " ✦ ")}${this.#theme.bold("pi-jscpd")}`;
    if (this.#phase !== "ready")
      return `${brand}${this.#theme.fg("dim", ` · ${this.#compactTitle()}`)} `;
    if (this.#view === "findings") {
      const visible = this.#filteredEntries().length;
      const retained = this.#cachedEntries().length;
      return `${brand}${this.#theme.fg("dim", " · ")}${this.#pill(`${visible}/${retained} findings`, visible > 0 ? "accent" : "warning")} `;
    }
    if (this.#view === "help")
      return `${brand}${this.#theme.fg("dim", " · ")}${this.#pill("help", "accent")} `;
    const mode = this.#status?.mode ?? "loading";
    return `${brand}${this.#theme.fg("dim", " · ")}${this.#pill(mode, mode === "enabled" ? "success" : "warning")} `;
  }

  #compactTitle(): string {
    if (this.#phase === "loading") return "loading";
    if (this.#phase === "cancelling") return "cancelling";
    if (this.#phase === "running") return this.#activeCommand ?? "working";
    return this.#view;
  }

  #footer(): string {
    if (this.#phase !== "ready") return "Esc cancel · q cancel and close";
    if (this.#filtering) return "Type to search · Enter apply · Esc cancel · Ctrl+U clear";
    if (this.#view === "findings") {
      const selected = this.#markedFindings.size
        ? `${this.#markedFindings.size} selected`
        : "current finding";
      const load = this.#hasMoreCachedFindings() ? " · L next 10" : "";
      return `${selected} · ↑↓ navigate${load} · Enter expand · s select · e load · ? help · Esc back · q close`;
    }
    if (this.#view === "help") return "Esc or Shift+Tab overview · q close";
    return "↑↓ navigate · Enter select · c changes · s scan · ? help · q close";
  }

  #pill(text: string, color: "accent" | "muted" | "success" | "warning"): string {
    return this.#theme.fg(color, ` ${text} `);
  }

  #topBorder(width: number, title: string): string {
    const clipped = truncateToWidth(title, Math.max(0, width - 2), "");
    const fill = Math.max(0, width - visibleWidth(clipped) - 2);
    return `${this.#theme.fg("borderAccent", "╭")}${clipped}${this.#theme.fg("borderAccent", `${"─".repeat(fill)}╮`)}`;
  }

  #separator(width: number): string {
    return this.#theme.fg("borderAccent", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  #bottomBorder(width: number): string {
    return this.#theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  #frame(content: string, width: number): string {
    const innerWidth = Math.max(0, width - 4);
    const bounded = truncateToWidth(content, innerWidth);
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(bounded)));
    return `${this.#theme.fg("borderAccent", "│ ")}${bounded}${padding}${this.#theme.fg("borderAccent", " │")}`;
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

export function buildJscpdOverlayPrompt(
  findings: readonly OverlayFinding[],
  scope: "changed" | "project",
): { readonly prompt: string; readonly findingCount: number } {
  const selected = findings.slice(0, PROMPT_FINDING_LIMIT);
  const lines = [
    "Review the following jscpd duplicate blocks.",
    "Inspect both locations and surrounding behavior before deciding whether the duplication should be refactored or intentionally retained.",
    "Do not change source or configuration until you have explained the evidence and proposed the safest next step.",
    "",
  ];
  let findingCount = 0;
  for (const [index, finding] of selected.entries()) {
    const block = [...jscpdFindingDetailLines(finding, index + 1, findings.length), ""];
    const candidate = [...lines, ...block].join("\n");
    if (Array.from(candidate).length > PROMPT_CHARACTER_LIMIT) break;
    lines.push(...block);
    findingCount += 1;
  }
  lines.push(...jscpdFindingGuidance(scope));
  const prompt = Array.from(lines.join("\n")).slice(0, PROMPT_CHARACTER_LIMIT).join("");
  return Object.freeze({ prompt, findingCount });
}

async function safeExecute(
  executor: JscpdOverlayExecutor,
  command: JscpdCommand,
  cwd: string,
  signal?: AbortSignal,
  overlayFindingLimit?: number,
): Promise<JscpdExecutionResult> {
  try {
    return await executor.execute(
      { command, args: [] },
      { cwd, signal, ...(overlayFindingLimit ? { overlayFindingLimit } : {}) },
    );
  } catch {
    return Object.freeze({
      status: "failed",
      reason: "process-failed",
      message: "The jscpd request failed safely; no source files were changed.",
    });
  }
}

function resultFindings(result?: JscpdExecutionResult): readonly OverlayFinding[] {
  if (result?.status === "changed" || result?.status === "completed") {
    return result.overlayCache?.findings ?? result.findings;
  }
  return [];
}

function resultTotal(result?: JscpdExecutionResult): number {
  if (result?.status === "completed") return result.summary.clones;
  if (result?.status === "changed") {
    return result.findings.length + result.omittedFindings + result.ambiguousFindings;
  }
  return 0;
}

function resultOmitted(result?: JscpdExecutionResult): number {
  if (result?.status === "changed" || result?.status === "completed") {
    return result.overlayCache?.omittedFindings ?? result.omittedFindings;
  }
  return 0;
}

function resultHasOverlayCache(result?: JscpdExecutionResult): boolean {
  return (
    (result?.status === "changed" || result?.status === "completed") &&
    result.overlayCache !== undefined
  );
}

function resultAmbiguous(result?: JscpdExecutionResult): number {
  return result?.status === "changed" ? result.ambiguousFindings : 0;
}

function resultVerification(result?: JscpdExecutionResult) {
  if (result?.status === "changed" || result?.status === "completed") {
    return result.verification;
  }
  return undefined;
}

function executionMessage(result: JscpdExecutionResult): string {
  return "terminalMessage" in result ? result.terminalMessage : result.message;
}

function statusLevel(result: JscpdExecutionResult): "info" | "warning" {
  return result.status === "status" ? "info" : "warning";
}

function middleTruncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  const characters = Array.from(value);
  const leftCount = Math.ceil((width - 1) / 2);
  const rightCount = Math.floor((width - 1) / 2);
  return `${truncateToWidth(characters.slice(0, leftCount).join(""), leftCount, "")}…${truncateToWidth(characters.slice(-rightCount).join(""), rightCount, "")}`;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
