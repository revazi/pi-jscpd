import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { JscpdDispatchResult } from "./types.js";

const MAX_CALL_TARGETS = 3;
const MAX_TARGET_CHARACTERS = 120;
const MAX_CWD_CHARACTERS = 180;
const MAX_EXPANDED_CHARACTERS = 100_000;
const MAX_EXPANDED_LINES = 512;
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  missing: "analyzer missing",
  incompatible: "analyzer incompatible",
  cancelled: "probe cancelled",
  "timed-out": "probe timed out",
  failed: "probe failed",
};
const PUBLIC_RESULT_STATUSES = new Set([
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
]);

type ToolCallArgs = {
  readonly command?: unknown;
  readonly args?: unknown;
};

type ToolRenderResult = {
  readonly details?: unknown;
};

type Tone = "success" | "warning" | "error" | "muted";

interface CompactResult {
  readonly tone: Tone;
  readonly headline: string;
  readonly metadata?: string;
}

type CompactRenderer = (details: JscpdDispatchResult) => CompactResult;

const COMPACT_RENDERERS: Readonly<Record<JscpdDispatchResult["status"], CompactRenderer>> = {
  completed: (details) =>
    completedCompact(details as Extract<JscpdDispatchResult, { status: "completed" }>),
  changed: (details) =>
    changedCompact(details as Extract<JscpdDispatchResult, { status: "changed" }>),
  unavailable: (details) =>
    unavailableCompact((details as Extract<JscpdDispatchResult, { status: "unavailable" }>).reason),
  "changed-unavailable": (details) =>
    changedUnavailableCompact(
      (details as Extract<JscpdDispatchResult, { status: "changed-unavailable" }>).reason,
    ),
  failed: (details) =>
    failedCompact((details as Extract<JscpdDispatchResult, { status: "failed" }>).reason),
  status: (details) => statusCompact(details as Extract<JscpdDispatchResult, { status: "status" }>),
  control: (details) =>
    controlCompact(details as Extract<JscpdDispatchResult, { status: "control" }>),
  help: () => ({ tone: "muted", headline: "jscpd help" }),
  invalid: (details) => ({
    tone: "error",
    headline: "Invalid jscpd request",
    metadata: reasonLabel((details as Extract<JscpdDispatchResult, { status: "invalid" }>).reason),
  }),
  error: (details) => ({
    tone: "error",
    headline: "jscpd could not run",
    metadata: reasonLabel((details as Extract<JscpdDispatchResult, { status: "error" }>).reason),
  }),
};

/** Render the bounded jscpd operation, scan targets, and Pi-provided working directory. */
export function renderJscpdToolCall(args: ToolCallArgs, theme: Theme, cwd: string): Text {
  const command = jscpdCommand(args.command);
  const targets = command === "scan" ? scanTargetSummary(args.args) : undefined;
  const location = boundedInline(displayToken(cwd || "."), MAX_CWD_CHARACTERS);
  const content = [
    theme.fg("toolTitle", theme.bold("jscpd ")),
    theme.fg("accent", command),
    targets ? theme.fg("muted", ` ${targets}`) : "",
    theme.fg("dim", ` in ${location}`),
  ].join("");
  return new Text(content, 0, 0);
}

/** Render only normalized public details; model content and overlay-only caches are never read. */
export function renderJscpdToolResult(
  result: ToolRenderResult,
  options: { readonly expanded?: boolean; readonly isPartial?: boolean },
  theme: Theme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Running jscpd…"), 0, 0);
  }

  const details = publicDetails(result.details);
  if (!details) {
    return new Text(theme.fg("dim", "No jscpd result details"), 0, 0);
  }

  const compact = compactResult(details);
  let content = theme.fg(compact.tone, compact.headline);
  if (compact.metadata) content += theme.fg("dim", ` · ${compact.metadata}`);

  if (options.expanded) {
    const expanded = expandedPublicMessage(details);
    if (expanded) content += `\n${styleExpandedMessage(expanded, theme)}`;
  }

  return new Text(content, 0, 0);
}

function publicDetails(value: unknown): JscpdDispatchResult | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return PUBLIC_RESULT_STATUSES.has(value.status)
    ? (value as unknown as JscpdDispatchResult)
    : undefined;
}

function compactResult(details: JscpdDispatchResult): CompactResult {
  return COMPACT_RENDERERS[details.status](details);
}

function statusCompact(details: Extract<JscpdDispatchResult, { status: "status" }>): CompactResult {
  const mode = details.mode === "enabled" || details.mode === "disabled" ? details.mode : "status";
  return {
    tone: mode === "enabled" ? "success" : "warning",
    headline: mode === "status" ? "jscpd status unavailable" : `jscpd ${mode}`,
    metadata: [capabilityLabel(details.capability), lastCheckLabel(details.lastCheck)].join(" · "),
  };
}

function controlCompact(
  details: Extract<JscpdDispatchResult, { status: "control" }>,
): CompactResult {
  const action =
    details.action === "enabled" || details.action === "disabled" ? details.action : undefined;
  return {
    tone: action === "enabled" ? "success" : "warning",
    headline: action ? `jscpd ${action} for this session` : "jscpd session state updated",
  };
}

function completedCompact(
  details: Extract<JscpdDispatchResult, { status: "completed" }>,
): CompactResult {
  if (details.outcome === "clean") {
    const sources = safeCount(details.summary?.sources);
    return {
      tone: "success",
      headline: "No duplicate blocks found",
      metadata: sources === undefined ? undefined : plural(sources, "source"),
    };
  }

  const clones = safeCount(details.summary?.clones) ?? findingTotal(details);
  const duplicatedLines = safeCount(details.summary?.duplicatedLines);
  return {
    tone: "warning",
    headline: `${plural(clones, "duplicate block")} found`,
    metadata:
      duplicatedLines === undefined ? undefined : `${plural(duplicatedLines, "duplicated line")}`,
  };
}

function changedCompact(
  details: Extract<JscpdDispatchResult, { status: "changed" }>,
): CompactResult {
  if (details.outcome === "clean") {
    return {
      tone: "success",
      headline: details.scanPerformed
        ? "No new duplicate blocks found"
        : "No session changes to scan",
      metadata: ambiguityLabel(details.ambiguousFindings),
    };
  }

  return {
    tone: "warning",
    headline: `${plural(findingTotal(details), "new duplicate block")} found`,
    metadata: ambiguityLabel(details.ambiguousFindings),
  };
}

function unavailableCompact(reason: string): CompactResult {
  switch (reason) {
    case "probe-cancelled":
      return { tone: "muted", headline: "jscpd check cancelled" };
    case "probe-timed-out":
      return { tone: "warning", headline: "jscpd check timed out" };
    case "disabled":
      return { tone: "warning", headline: "jscpd is disabled for this session" };
    case "missing-binary":
      return { tone: "warning", headline: "jscpd unavailable", metadata: "analyzer missing" };
    case "incompatible-version":
      return { tone: "warning", headline: "jscpd unavailable", metadata: "incompatible analyzer" };
    default:
      return { tone: "warning", headline: "jscpd unavailable", metadata: reasonLabel(reason) };
  }
}

function changedUnavailableCompact(reason: string): CompactResult {
  if (reason === "baseline-cancelled") {
    return { tone: "muted", headline: "Changed check cancelled" };
  }
  if (reason === "baseline-timed-out") {
    return { tone: "warning", headline: "Changed check timed out" };
  }
  return { tone: "warning", headline: "Changed check unavailable", metadata: reasonLabel(reason) };
}

function failedCompact(reason: string): CompactResult {
  if (reason === "scan-cancelled") return { tone: "muted", headline: "jscpd scan cancelled" };
  if (reason === "scan-timed-out") return { tone: "warning", headline: "jscpd scan timed out" };
  return { tone: "warning", headline: "jscpd scan failed open", metadata: reasonLabel(reason) };
}

function capabilityLabel(value: unknown): string {
  if (!isRecord(value) || typeof value.status !== "string") return "analyzer state unavailable";
  if (value.status !== "available") {
    return CAPABILITY_LABELS[value.status] ?? "analyzer state unavailable";
  }

  const executable = safeInline(value.executable) ?? "jscpd";
  const version = safeInline(value.version);
  const source =
    value.source === "bundled"
      ? "bundled"
      : value.source === "project-or-path"
        ? "project/PATH"
        : undefined;
  return [executable, version, source].filter(Boolean).join(" ");
}

function lastCheckLabel(value: unknown): string {
  if (!isRecord(value) || typeof value.state !== "string") return "last check unavailable";
  switch (value.state) {
    case "never":
      return "not checked yet";
    case "clean":
      return "last check clean";
    case "findings": {
      const clones = safeCount(value.clones);
      return clones === undefined
        ? "last check found duplication"
        : `last check ${plural(clones, "block")}`;
    }
    case "cancelled":
      return "last check cancelled";
    case "failed":
      return "last check failed";
    default:
      return "last check unavailable";
  }
}

function expandedPublicMessage(details: JscpdDispatchResult): string | undefined {
  const candidate =
    "terminalMessage" in details && typeof details.terminalMessage === "string"
      ? details.terminalMessage
      : typeof details.message === "string"
        ? details.message
        : undefined;
  if (!candidate) return undefined;
  return boundedMultiline(candidate);
}

function styleExpandedMessage(message: string, theme: Theme): string {
  return message
    .split("\n")
    .map((line) => theme.fg("muted", line))
    .join("\n");
}

function scanTargetSummary(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const targets = value.filter((item): item is string => typeof item === "string");
  if (targets.length === 0) return undefined;
  const visible = targets
    .slice(0, MAX_CALL_TARGETS)
    .map((target) => boundedInline(displayToken(target), MAX_TARGET_CHARACTERS));
  if (targets.length > visible.length) visible.push(`… +${targets.length - visible.length}`);
  return visible.join(" ");
}

function jscpdCommand(value: unknown): string {
  switch (value) {
    case "scan":
    case "changed":
    case "status":
    case "off":
    case "on":
    case "help":
      return value;
    default:
      return "run";
  }
}

function findingTotal(details: {
  readonly findings?: unknown;
  readonly omittedFindings?: unknown;
}): number {
  const shown = Array.isArray(details.findings) ? details.findings.length : 0;
  return shown + (safeCount(details.omittedFindings) ?? 0);
}

function ambiguityLabel(value: unknown): string | undefined {
  const count = safeCount(value);
  return count && count > 0 ? plural(count, "unclassified block") : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeInline(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? boundedInline(displayToken(value), MAX_TARGET_CHARACTERS)
    : undefined;
}

function displayToken(value: string): string {
  const safeValue = escapeControlCharacters(value, false);
  return /^[\p{L}\p{N}_./@:+~-]+$/u.test(safeValue) ? safeValue : JSON.stringify(safeValue);
}

function boundedInline(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  const retained = maximum - 1;
  const beginning = Math.ceil(retained / 2);
  const ending = Math.floor(retained / 2);
  return `${characters.slice(0, beginning).join("")}…${characters.slice(-ending).join("")}`;
}

function boundedMultiline(value: string): string {
  const sanitized = escapeControlCharacters(
    value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
    true,
  );
  const sourceLines = sanitized.split("\n");
  const lines = sourceLines.slice(0, MAX_EXPANDED_LINES);
  let result = Array.from(lines.join("\n")).slice(0, MAX_EXPANDED_CHARACTERS).join("");
  if (
    sourceLines.length > lines.length ||
    Array.from(lines.join("\n")).length > MAX_EXPANDED_CHARACTERS
  ) {
    result += "\n… transcript detail truncated";
  }
  return result;
}

function escapeControlCharacters(value: string, preserveNewlines: boolean): string {
  return Array.from(value)
    .map((character) => {
      if (preserveNewlines && character === "\n") return character;
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        ? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : character;
    })
    .join("");
}

function reasonLabel(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? boundedInline(escapeControlCharacters(value.replaceAll("-", " "), false), 80)
    : "details unavailable";
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
