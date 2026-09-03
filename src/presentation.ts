import {
  boundedJscpdDisplayPath,
  jscpdFindingDetailLines,
  jscpdFindingGuidance,
} from "./finding-presentation.js";
import type {
  JscpdChangedFinding,
  JscpdChangedResult,
  JscpdCompletedResult,
  JscpdPresentedFinding,
  JscpdScanReport,
  JscpdScanSummary,
} from "./types.js";

const DEFAULT_MAX_PRESENTED_FINDINGS = 10;
const MAX_CONFIGURED_PRESENTED_FINDINGS = 100;

/** Build bounded model and terminal views from one normalized jscpd report. */
export function presentJscpdScan(
  report: JscpdScanReport,
  configuredMaxFindings = DEFAULT_MAX_PRESENTED_FINDINGS,
): JscpdCompletedResult {
  const summary = scanSummary(report);
  const maxFindings = boundedFindingLimit(configuredMaxFindings);
  const findings = report.clonePairs.slice(0, maxFindings).map(presentFinding);
  const omittedFindings = Math.max(0, report.clonePairs.length - findings.length);
  const outcome = findings.length === 0 ? "clean" : "findings";

  if (outcome === "clean") {
    const text = `jscpd scan clean: 0 duplicate blocks across ${summary.lines} lines and ${summary.tokens} tokens in ${summary.sources} sources.`;
    return {
      status: "completed",
      outcome,
      message: text,
      terminalMessage: text,
      summary,
      findings,
      omittedFindings,
    };
  }

  const headline = `jscpd found ${plural(summary.clones, "duplicate block")}: ${summary.duplicatedLines} duplicated lines (${formatPercentage(summary.percentage)}) and ${summary.duplicatedTokens} duplicated tokens (${formatPercentage(summary.percentageTokens)}) across ${summary.sources} sources.`;
  const findingLines = findings.flatMap((finding, index) =>
    jscpdFindingDetailLines(finding, index + 1, summary.clones),
  );
  const omittedLine =
    omittedFindings > 0
      ? [`${plural(omittedFindings, "additional duplicate block")} omitted by the display limit.`]
      : [];
  const message = [
    headline,
    ...findingLines,
    ...omittedLine,
    ...jscpdFindingGuidance("project"),
  ].join("\n");

  return {
    status: "completed",
    outcome,
    message,
    terminalMessage: message,
    summary,
    findings,
    omittedFindings,
  };
}

/** Present only unacknowledged net-new groups involving session-owned files. */
export function presentJscpdChanged(
  clonePairs: readonly JscpdScanReport["clonePairs"][number][],
  changedFiles: ReadonlySet<string>,
  configuredMaxFindings = DEFAULT_MAX_PRESENTED_FINDINGS,
  ambiguousFindings = 0,
): JscpdChangedResult {
  const maxFindings = boundedFindingLimit(configuredMaxFindings);
  const findings = clonePairs
    .slice(0, maxFindings)
    .map((pair) => presentChangedFinding(pair, changedFiles));
  const omittedFindings = Math.max(0, clonePairs.length - findings.length);
  const outcome = findings.length === 0 ? "clean" : "findings";
  const ambiguity =
    ambiguousFindings > 0
      ? ` ${plural(ambiguousFindings, "clone group")} could not be classified conservatively.`
      : "";
  if (outcome === "clean") {
    const message = `jscpd changed: no unacknowledged new duplicate blocks involve session-owned changed files.${ambiguity}`;
    return Object.freeze({
      status: "changed",
      outcome,
      scanPerformed: true,
      message,
      terminalMessage: message,
      findings: Object.freeze(findings),
      omittedFindings,
      ambiguousFindings,
    });
  }
  const headline = `jscpd changed found ${plural(clonePairs.length, "unacknowledged new duplicate block")} involving session-owned changed files.`;
  const findingLines = findings.flatMap((finding, index) =>
    jscpdFindingDetailLines(finding, index + 1, clonePairs.length),
  );
  const omittedLine =
    omittedFindings > 0
      ? [
          `${plural(omittedFindings, "additional new duplicate block")} omitted by the display limit and not acknowledged.`,
        ]
      : [];
  const message = [
    headline,
    ...findingLines,
    ...omittedLine,
    ambiguity.trim(),
    ...jscpdFindingGuidance("changed"),
  ]
    .filter(Boolean)
    .join("\n");
  return Object.freeze({
    status: "changed",
    outcome,
    scanPerformed: true,
    message,
    terminalMessage: message,
    findings: Object.freeze(findings),
    omittedFindings,
    ambiguousFindings,
  });
}

function boundedFindingLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONFIGURED_PRESENTED_FINDINGS
    ? value
    : DEFAULT_MAX_PRESENTED_FINDINGS;
}

function scanSummary(report: JscpdScanReport): JscpdScanSummary {
  const total = report.statistics.total;
  return Object.freeze({
    clones: total.clones,
    duplicatedLines: total.duplicatedLines,
    duplicatedTokens: total.duplicatedTokens,
    lines: total.lines,
    tokens: total.tokens,
    sources: total.sources,
    percentage: total.percentage,
    percentageTokens: total.percentageTokens,
  });
}

function presentFinding(pair: JscpdScanReport["clonePairs"][number]): JscpdPresentedFinding {
  const [first, second] = pair.occurrences;
  return Object.freeze({
    format: pair.format,
    lines: pair.lines,
    tokens: pair.tokens,
    occurrences: Object.freeze([
      Object.freeze({
        path: boundedJscpdDisplayPath(first.path),
        startLine: first.start.line,
        endLine: first.end.line,
      }),
      Object.freeze({
        path: boundedJscpdDisplayPath(second.path),
        startLine: second.start.line,
        endLine: second.end.line,
      }),
    ]) as readonly [
      JscpdPresentedFinding["occurrences"][0],
      JscpdPresentedFinding["occurrences"][1],
    ],
  });
}

function presentChangedFinding(
  pair: JscpdScanReport["clonePairs"][number],
  changedFiles: ReadonlySet<string>,
): JscpdChangedFinding {
  const occurrences = pair.occurrences.map((occurrence) =>
    Object.freeze({
      path: boundedJscpdDisplayPath(occurrence.path),
      startLine: occurrence.start.line,
      endLine: occurrence.end.line,
      relation: changedFiles.has(occurrence.path) ? "new-session" : "existing-match",
    }),
  ) as [JscpdChangedFinding["occurrences"][0], JscpdChangedFinding["occurrences"][1]];
  return Object.freeze({
    format: pair.format,
    lines: pair.lines,
    tokens: pair.tokens,
    occurrences: Object.freeze(occurrences),
  });
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatPercentage(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}
