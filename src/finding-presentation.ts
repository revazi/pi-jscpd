import type { JscpdChangedFinding, JscpdPresentedFinding } from "./types.js";

const MAX_DISPLAY_PATH_CHARACTERS = 240;

export type JscpdDisplayFinding = JscpdChangedFinding | JscpdPresentedFinding;
export type JscpdFindingScope = "changed" | "project";

export interface JscpdDisplayLocation {
  readonly label: "new in this session" | "existing match" | "current location";
  readonly text: string;
}

/** Bound a user-controlled display path by Unicode code points with context at both ends. */
export function boundedJscpdDisplayPath(path: string): string {
  const characters = Array.from(path);
  if (characters.length <= MAX_DISPLAY_PATH_CHARACTERS) return path;
  const retained = MAX_DISPLAY_PATH_CHARACTERS - 1;
  const beginning = Math.ceil(retained / 2);
  const ending = Math.floor(retained / 2);
  return `${characters.slice(0, beginning).join("")}…${characters.slice(-ending).join("")}`;
}

export function jscpdFindingLocations(
  finding: JscpdDisplayFinding,
): readonly [JscpdDisplayLocation, JscpdDisplayLocation] {
  const locations = finding.occurrences.map((occurrence) =>
    Object.freeze({
      label: jscpdOccurrenceLabel(occurrence),
      text: `${occurrence.path}:${occurrence.startLine}-${occurrence.endLine}`,
    }),
  );
  return Object.freeze(locations) as readonly [JscpdDisplayLocation, JscpdDisplayLocation];
}

export function jscpdFindingMetadata(finding: JscpdDisplayFinding): string {
  return `${finding.lines} lines | ${finding.tokens} tokens | ${finding.format}`;
}

/** Shared detail block used by slash/model text and the interactive detail view. */
export function jscpdFindingDetailLines(
  finding: JscpdDisplayFinding,
  ordinal: number,
  total: number,
): readonly string[] {
  const [first, second] = jscpdFindingLocations(finding);
  return Object.freeze([
    `Duplicate block ${ordinal} of ${total}`,
    `${first.label}: ${first.text}`,
    `${second.label}: ${second.text}`,
    jscpdFindingMetadata(finding),
  ]);
}

/** Shared advisory and inspect/refactor/intentional-configuration guidance. */
export function jscpdFindingGuidance(scope: JscpdFindingScope): readonly string[] {
  const classification =
    scope === "changed"
      ? "“new in this session” marks a tracked changed file; “existing match” marks the other current location."
      : "A full-project scan reports two current locations; it does not determine which location is new.";
  return Object.freeze([
    classification,
    "Duplication may be intentional; inspect both locations and surrounding behavior before changing code.",
    "If shared behavior should stay synchronized, refactor through the normal agent flow, run relevant tests, then rescan.",
    "If the duplication is intentional, keep it or update existing jscpd ignore/exclusion configuration through the normal agent flow.",
  ]);
}

function jscpdOccurrenceLabel(
  occurrence: JscpdDisplayFinding["occurrences"][number],
): JscpdDisplayLocation["label"] {
  if (!("relation" in occurrence)) return "current location";
  return occurrence.relation === "new-session" ? "new in this session" : "existing match";
}
