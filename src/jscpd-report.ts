import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  JscpdCloneOccurrence,
  JscpdClonePair,
  JscpdFormatStatistics,
  JscpdReportDecision,
  JscpdReportErrorCode,
  JscpdScanReport,
  JscpdScanStatistics,
  JscpdSourceLocation,
  JscpdStatisticsRow,
} from "./types.js";

/** Fixed by jscpd v5's JSON reporter; CLI argument construction belongs to issue #12. */
export const JSCPD_STRUCTURED_REPORTER = "json";
export const JSCPD_STRUCTURED_REPORT_FILE_NAME = "jscpd-report.json";

const MAX_REPORT_BYTES = 16 * 1_024 * 1_024;
const MAX_CLONE_PAIRS = 1_000;
const MAX_FORMATS = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_FORMAT_BYTES = 128;
const MAX_DATE_BYTES = 128;
const MAX_U32 = 0xffff_ffff;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_KEYS = 100_000;
const MAX_JSON_KEYS_PER_OBJECT = 2_048;
const PATH_RESOLUTION_CONCURRENCY = 16;

const REPORT_ERROR_CODES = new Set<JscpdReportErrorCode>([
  "malformed-json",
  "unsupported-reporter",
  "invalid-top-level",
  "invalid-duplicates",
  "invalid-statistics",
  "invalid-location",
  "unsafe-path",
  "limit-exceeded",
  "duplicate-key",
  "ambiguous-path",
  "ambiguous-duplicate",
]);

interface ReporterPathCandidates {
  readonly key: string;
  readonly exact: string;
  readonly embeddedBase?: string;
}

interface UnresolvedOccurrence {
  readonly reporterPath: string;
  readonly start: JscpdSourceLocation;
  readonly end: JscpdSourceLocation;
}

interface UnresolvedClonePair {
  readonly format: string;
  readonly lines: number;
  readonly tokens: number;
  readonly occurrences: readonly [UnresolvedOccurrence, UnresolvedOccurrence];
}

interface JsonObjectContainer {
  readonly kind: "object";
  readonly keys: Set<string>;
}

interface JsonArrayContainer {
  readonly kind: "array";
}

type JsonContainer = JsonObjectContainer | JsonArrayContainer;

interface JsonDuplicateKeyScan {
  readonly containers: JsonContainer[];
  keyCount: number;
}

interface ParsedReport {
  readonly statistics: JscpdScanStatistics;
  readonly clonePairs: readonly UnresolvedClonePair[];
}

class ReportValidationError extends Error {
  readonly code: JscpdReportErrorCode;

  constructor(code: JscpdReportErrorCode) {
    super("The jscpd report did not satisfy the bounded v5 JSON contract.");
    this.name = "ReportValidationError";
    this.code = code;
  }
}

/**
 * Validate and normalize bounded jscpd v5 JSON bytes for the adapter's consumeReport boundary.
 * Rejections are intentionally body-free; unexpected implementation failures still reject the
 * consumer promise and are normalized by the process adapter.
 */
export async function consumeJscpdV5JsonReport(
  bytes: Uint8Array,
  cwd: string,
): Promise<JscpdReportDecision<JscpdScanReport>> {
  try {
    const parsed = parseReportBytes(bytes);
    const report = await normalizeReportPaths(parsed, cwd);
    return report.clonePairs.length === 0
      ? { status: "no-findings" }
      : { status: "accepted", value: report };
  } catch (error) {
    if (error instanceof ReportValidationError) {
      return { status: "rejected", reason: error.code };
    }
    throw error;
  }
}

export function isJscpdReportErrorCode(value: unknown): value is JscpdReportErrorCode {
  return typeof value === "string" && REPORT_ERROR_CODES.has(value as JscpdReportErrorCode);
}

function parseReportBytes(bytes: Uint8Array): ParsedReport {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail("malformed-json");
  }
  if (bytes.byteLength > MAX_REPORT_BYTES) {
    fail("limit-exceeded");
  }

  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    fail("malformed-json");
  }
  rejectDuplicateJsonKeys(text);

  const topLevel = requireRecord(value, "invalid-top-level");
  rejectUnsupportedReporter(topLevel);
  const duplicates = requireArray(
    requiredProperty(topLevel, "duplicates", "invalid-top-level"),
    "invalid-duplicates",
  );
  if (duplicates.length > MAX_CLONE_PAIRS) {
    fail("limit-exceeded");
  }

  const clonePairs = duplicates.map(parseClonePair);
  const statistics = parseStatistics(requiredProperty(topLevel, "statistics", "invalid-top-level"));
  validateCloneStatistics(clonePairs, statistics);
  return { statistics, clonePairs };
}

function rejectDuplicateJsonKeys(text: string): void {
  const scan: JsonDuplicateKeyScan = { containers: [], keyCount: 0 };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      index = inspectJsonString(text, index, scan);
    } else {
      updateJsonContainers(character, scan.containers);
    }
  }
}

function updateJsonContainers(character: string | undefined, containers: JsonContainer[]): void {
  switch (character) {
    case "{":
      containers.push({ kind: "object", keys: new Set() });
      enforceJsonDepth(containers.length);
      break;
    case "[":
      containers.push({ kind: "array" });
      enforceJsonDepth(containers.length);
      break;
    case "}":
    case "]":
      containers.pop();
      break;
  }
}

function inspectJsonString(text: string, start: number, scan: JsonDuplicateKeyScan): number {
  const stringEnd = findJsonStringEnd(text, start);
  if (stringEnd === undefined) {
    return text.length;
  }
  const container = scan.containers.at(-1);
  if (nextJsonToken(text, stringEnd + 1) !== ":" || container?.kind !== "object") {
    return stringEnd;
  }

  const key = JSON.parse(text.slice(start, stringEnd + 1)) as unknown;
  if (typeof key !== "string") {
    fail("malformed-json");
  }
  registerJsonKey(key, container, scan);
  return stringEnd;
}

function registerJsonKey(
  key: string,
  container: JsonObjectContainer,
  scan: JsonDuplicateKeyScan,
): void {
  if (container.keys.has(key)) {
    fail("duplicate-key");
  }
  scan.keyCount += 1;
  if (scan.keyCount > MAX_JSON_KEYS || container.keys.size >= MAX_JSON_KEYS_PER_OBJECT) {
    fail("limit-exceeded");
  }
  container.keys.add(key);
}

function findJsonStringEnd(text: string, start: number): number | undefined {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') {
      return index;
    }
  }
  return undefined;
}

function nextJsonToken(text: string, start: number): string | undefined {
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
      return character;
    }
  }
  return undefined;
}

function enforceJsonDepth(depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    fail("limit-exceeded");
  }
}

function rejectUnsupportedReporter(topLevel: Readonly<Record<string, unknown>>): void {
  if (
    Object.hasOwn(topLevel, "statistic") ||
    Object.hasOwn(topLevel, "runs") ||
    Object.hasOwn(topLevel, "$schema") ||
    Object.hasOwn(topLevel, "clones")
  ) {
    fail("unsupported-reporter");
  }
}

function parseClonePair(value: unknown): UnresolvedClonePair {
  const duplicate = requireRecord(value, "invalid-duplicates");
  const format = requireText(
    requiredProperty(duplicate, "format", "invalid-duplicates"),
    MAX_FORMAT_BYTES,
    "invalid-duplicates",
  );
  const lines = requirePositiveU32(
    requiredProperty(duplicate, "lines", "invalid-duplicates"),
    "invalid-duplicates",
  );
  if (typeof requiredProperty(duplicate, "fragment", "invalid-duplicates") !== "string") {
    fail("invalid-duplicates");
  }
  if (Object.hasOwn(duplicate, "isNew") && typeof duplicate.isNew !== "boolean") {
    fail("invalid-duplicates");
  }
  const tokens = requirePositiveU32(
    requiredProperty(duplicate, "tokens", "invalid-duplicates"),
    "invalid-duplicates",
  );
  const first = parseOccurrence(requiredProperty(duplicate, "firstFile", "invalid-duplicates"));
  const second = parseOccurrence(requiredProperty(duplicate, "secondFile", "invalid-duplicates"));

  if (
    lines !== first.end.line - first.start.line + 1 ||
    lines !== second.end.line - second.start.line + 1
  ) {
    fail("invalid-location");
  }
  return { format, lines, tokens, occurrences: [first, second] };
}

function parseOccurrence(value: unknown): UnresolvedOccurrence {
  const occurrence = requireRecord(value, "invalid-duplicates");
  const reporterPath = requireText(
    requiredProperty(occurrence, "name", "invalid-duplicates"),
    MAX_PATH_BYTES,
    "unsafe-path",
  );
  const startLine = requirePositiveU32(
    requiredProperty(occurrence, "start", "invalid-location"),
    "invalid-location",
  );
  const endLine = requirePositiveU32(
    requiredProperty(occurrence, "end", "invalid-location"),
    "invalid-location",
  );
  const start = parseLocation(requiredProperty(occurrence, "startLoc", "invalid-location"));
  const end = parseLocation(requiredProperty(occurrence, "endLoc", "invalid-location"));

  if (
    start.line !== startLine ||
    end.line !== endLine ||
    !locationComesBefore(start, end) ||
    start.offset >= end.offset
  ) {
    fail("invalid-location");
  }
  return { reporterPath, start, end };
}

function parseLocation(value: unknown): JscpdSourceLocation {
  const location = requireRecord(value, "invalid-location");
  return Object.freeze({
    line: requirePositiveU32(
      requiredProperty(location, "line", "invalid-location"),
      "invalid-location",
    ),
    column: requireU32(
      requiredProperty(location, "column", "invalid-location"),
      "invalid-location",
    ),
    offset: requireU32(
      requiredProperty(location, "position", "invalid-location"),
      "invalid-location",
    ),
  });
}

function locationComesBefore(start: JscpdSourceLocation, end: JscpdSourceLocation): boolean {
  return start.line < end.line || (start.line === end.line && start.column < end.column);
}

function parseStatistics(value: unknown): JscpdScanStatistics {
  const statistics = requireRecord(value, "invalid-statistics");
  requireText(
    requiredProperty(statistics, "detectionDate", "invalid-statistics"),
    MAX_DATE_BYTES,
    "invalid-statistics",
  );
  const total = parseStatisticsRow(requiredProperty(statistics, "total", "invalid-statistics"));
  const formatsRecord = requireRecord(
    requiredProperty(statistics, "formats", "invalid-statistics"),
    "invalid-statistics",
  );
  const formatEntries = Object.entries(formatsRecord);
  if (formatEntries.length > MAX_FORMATS) {
    fail("limit-exceeded");
  }

  const formats = formatEntries
    .map(([format, row]): JscpdFormatStatistics => {
      const normalizedFormat = requireText(format, MAX_FORMAT_BYTES, "invalid-statistics");
      return Object.freeze({ format: normalizedFormat, ...parseStatisticsRow(row) });
    })
    .sort((left, right) => compareText(left.format, right.format));
  return Object.freeze({ total, formats: Object.freeze(formats) });
}

function parseStatisticsRow(value: unknown): JscpdStatisticsRow {
  const row = requireRecord(value, "invalid-statistics");
  const normalized: JscpdStatisticsRow = {
    lines: requireCount(requiredProperty(row, "lines", "invalid-statistics")),
    tokens: requireCount(requiredProperty(row, "tokens", "invalid-statistics")),
    sources: requireCount(requiredProperty(row, "sources", "invalid-statistics")),
    clones: requireCount(requiredProperty(row, "clones", "invalid-statistics")),
    duplicatedLines: requireCount(requiredProperty(row, "duplicatedLines", "invalid-statistics")),
    duplicatedTokens: requireCount(requiredProperty(row, "duplicatedTokens", "invalid-statistics")),
    percentage: requirePercentage(requiredProperty(row, "percentage", "invalid-statistics")),
    percentageTokens: requirePercentage(
      requiredProperty(row, "percentageTokens", "invalid-statistics"),
    ),
    newDuplicatedLines: requireCount(
      requiredProperty(row, "newDuplicatedLines", "invalid-statistics"),
    ),
    newClones: requireCount(requiredProperty(row, "newClones", "invalid-statistics")),
  };
  if (
    normalized.newClones > normalized.clones ||
    normalized.newDuplicatedLines > normalized.duplicatedLines
  ) {
    fail("invalid-statistics");
  }
  return Object.freeze(normalized);
}

function validateCloneStatistics(
  clonePairs: readonly UnresolvedClonePair[],
  statistics: JscpdScanStatistics,
): void {
  if (statistics.total.clones !== clonePairs.length) {
    fail("invalid-statistics");
  }

  const clonesByFormat = countClonesByFormat(clonePairs);
  validateReportedCloneFormats(clonesByFormat, statistics.formats);
  validateStatisticsFormatRows(clonesByFormat, statistics.formats);
}

function countClonesByFormat(
  clonePairs: readonly UnresolvedClonePair[],
): ReadonlyMap<string, number> {
  const clonesByFormat = new Map<string, number>();
  for (const pair of clonePairs) {
    clonesByFormat.set(pair.format, (clonesByFormat.get(pair.format) ?? 0) + 1);
  }
  return clonesByFormat;
}

function validateReportedCloneFormats(
  clonesByFormat: ReadonlyMap<string, number>,
  formats: readonly JscpdFormatStatistics[],
): void {
  for (const [format, cloneCount] of clonesByFormat) {
    const formatStatistics = formats.find((row) => row.format === format);
    if (formatStatistics?.clones !== cloneCount) {
      fail("invalid-statistics");
    }
  }
}

function validateStatisticsFormatRows(
  clonesByFormat: ReadonlyMap<string, number>,
  formats: readonly JscpdFormatStatistics[],
): void {
  for (const row of formats) {
    if (row.clones !== (clonesByFormat.get(row.format) ?? 0)) {
      fail("invalid-statistics");
    }
  }
}

async function normalizeReportPaths(parsed: ParsedReport, cwd: string): Promise<JscpdScanReport> {
  const projectDirectory = await resolveProjectDirectory(cwd);
  const candidatePairs = parsed.clonePairs.map((pair) => {
    const [first, second] = pair.occurrences;
    return {
      ...pair,
      occurrences: [
        {
          ...first,
          candidatePath: prepareCandidatePath(first.reporterPath, pair.format, projectDirectory),
        },
        {
          ...second,
          candidatePath: prepareCandidatePath(second.reporterPath, pair.format, projectDirectory),
        },
      ] as const,
    };
  });
  const candidatePaths = new Map<string, ReporterPathCandidates>();
  for (const { occurrences } of candidatePairs) {
    for (const { candidatePath } of occurrences) {
      candidatePaths.set(candidatePath.key, candidatePath);
    }
  }
  const normalizedPaths = await resolveCandidatePaths(
    [...candidatePaths.values()],
    projectDirectory,
  );
  const seenPairs = new Set<string>();

  const clonePairs = candidatePairs.map((pair): JscpdClonePair => {
    const occurrences = pair.occurrences
      .map(
        ({ candidatePath, start, end }): JscpdCloneOccurrence =>
          Object.freeze({
            path: requiredNormalizedPath(normalizedPaths, candidatePath.key),
            start,
            end,
          }),
      )
      .sort((left, right) => compareText(occurrenceKey(left), occurrenceKey(right))) as [
      JscpdCloneOccurrence,
      JscpdCloneOccurrence,
    ];
    if (occurrenceKey(occurrences[0]) === occurrenceKey(occurrences[1])) {
      fail("ambiguous-duplicate");
    }
    const normalizedPair = Object.freeze({
      format: pair.format,
      lines: pair.lines,
      tokens: pair.tokens,
      occurrences: Object.freeze(occurrences),
    });
    const key = clonePairKey(normalizedPair);
    if (seenPairs.has(key)) {
      fail("ambiguous-duplicate");
    }
    seenPairs.add(key);
    return normalizedPair;
  });
  clonePairs.sort((left, right) => compareText(clonePairSortKey(left), clonePairSortKey(right)));

  return Object.freeze({
    statistics: parsed.statistics,
    clonePairs: Object.freeze(clonePairs),
  });
}

async function resolveProjectDirectory(cwd: string): Promise<string> {
  if (!isSafePathText(cwd) || !isAbsolute(cwd)) {
    fail("unsafe-path");
  }
  try {
    const canonical = await realpath(cwd);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() || !isSafePathText(canonical) || !isAbsolute(canonical)) {
      fail("unsafe-path");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ReportValidationError) {
      throw error;
    }
    fail("unsafe-path");
  }
}

function prepareCandidatePath(
  reporterPath: string,
  format: string,
  cwd: string,
): ReporterPathCandidates {
  if (!isSafePathText(reporterPath) || reporterPath.startsWith("file:")) {
    fail("unsafe-path");
  }
  if (
    process.platform !== "win32" &&
    (reporterPath.includes("\\") || isWindowsDrivePath(reporterPath))
  ) {
    fail("unsafe-path");
  }

  const exact = resolveSafeCandidatePath(reporterPath, cwd);
  const embeddedPath = embeddedFormatBasePath(reporterPath, format);
  const embeddedBase =
    embeddedPath === undefined ? undefined : resolveSafeCandidatePath(embeddedPath, cwd);
  return Object.freeze({
    key: JSON.stringify([exact, embeddedBase ?? null]),
    exact,
    ...(embeddedBase === undefined ? {} : { embeddedBase }),
  });
}

function resolveSafeCandidatePath(path: string, cwd: string): string {
  const pathIsAbsolute = isAbsolute(path);
  const candidatePath = resolve(cwd, path);
  if (
    Buffer.byteLength(candidatePath) > MAX_PATH_BYTES ||
    (!pathIsAbsolute && !isPathInside(cwd, candidatePath))
  ) {
    fail("unsafe-path");
  }
  return candidatePath;
}

function isWindowsDrivePath(path: string): boolean {
  const drive = path.codePointAt(0);
  return (
    drive !== undefined &&
    ((drive >= 0x41 && drive <= 0x5a) || (drive >= 0x61 && drive <= 0x7a)) &&
    path[1] === ":" &&
    (path[2] === "/" || path[2] === "\\")
  );
}

function embeddedFormatBasePath(path: string, format: string): string | undefined {
  const suffix = `:${format}`;
  if (!path.endsWith(suffix) || path.length === suffix.length) {
    return undefined;
  }
  const candidate = path.slice(0, -suffix.length);
  const finalCharacter = candidate.at(-1);
  return finalCharacter === "/" || finalCharacter === "\\" ? undefined : candidate;
}

async function resolveCandidatePaths(
  candidatePaths: readonly ReporterPathCandidates[],
  cwd: string,
): Promise<ReadonlyMap<string, string>> {
  const normalized = new Map<string, string>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < candidatePaths.length) {
      const candidate = candidatePaths[nextIndex];
      nextIndex += 1;
      if (candidate === undefined) {
        break;
      }
      normalized.set(candidate.key, await canonicalProjectPath(candidate, cwd));
    }
  };
  const workerCount = Math.min(PATH_RESOLUTION_CONCURRENCY, candidatePaths.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return normalized;
}

async function canonicalProjectPath(
  candidate: ReporterPathCandidates,
  cwd: string,
): Promise<string> {
  const paths =
    candidate.embeddedBase === undefined
      ? [candidate.exact]
      : [candidate.exact, candidate.embeddedBase];
  const resolved = await Promise.all(paths.map((path) => resolveRegularProjectFile(path, cwd)));
  const projectPaths = [...new Set(resolved.filter((path) => path !== undefined))];
  if (projectPaths.length === 0) {
    fail("unsafe-path");
  }
  if (projectPaths.length > 1) {
    fail("ambiguous-path");
  }
  return projectPaths[0] as string;
}

async function resolveRegularProjectFile(
  candidate: string,
  cwd: string,
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      return undefined;
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    fail("unsafe-path");
  }
  if (!isPathInside(cwd, canonical)) {
    fail("unsafe-path");
  }
  const projectRelative = relative(cwd, canonical);
  if (!isSafeProjectRelativePath(projectRelative)) {
    fail("unsafe-path");
  }
  return projectRelative.split(sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" || code === "ENOTDIR" || (process.platform === "win32" && code === "EINVAL")
  );
}

function isSafeProjectRelativePath(path: string): boolean {
  return isSafePathText(path) && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function requiredNormalizedPath(paths: ReadonlyMap<string, string>, candidate: string): string {
  const normalized = paths.get(candidate);
  if (!normalized) {
    throw new Error("Internal normalized report path invariant failed.");
  }
  return normalized;
}

function clonePairKey(pair: JscpdClonePair): string {
  return JSON.stringify([
    pair.format,
    occurrenceKey(pair.occurrences[0]),
    occurrenceKey(pair.occurrences[1]),
  ]);
}

function clonePairSortKey(pair: JscpdClonePair): string {
  return JSON.stringify([
    pair.format,
    occurrenceKey(pair.occurrences[0]),
    occurrenceKey(pair.occurrences[1]),
    pair.lines,
    pair.tokens,
  ]);
}

function occurrenceKey(occurrence: JscpdCloneOccurrence): string {
  return JSON.stringify([
    occurrence.path,
    occurrence.start.line,
    occurrence.start.column,
    occurrence.start.offset,
    occurrence.end.line,
    occurrence.end.column,
    occurrence.end.offset,
  ]);
}

function requiredProperty(
  record: Readonly<Record<string, unknown>>,
  property: string,
  code: JscpdReportErrorCode,
): unknown {
  if (!Object.hasOwn(record, property)) {
    fail(code);
  }
  return record[property];
}

function requireRecord(
  value: unknown,
  code: JscpdReportErrorCode,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, code: JscpdReportErrorCode): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(code);
  }
  return value;
}

function requireText(value: unknown, maxBytes: number, code: JscpdReportErrorCode): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasControlCharacters(value) ||
    Buffer.byteLength(value) > maxBytes
  ) {
    fail(code);
  }
  return value;
}

function isSafePathText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasControlCharacters(value) &&
    Buffer.byteLength(value) <= MAX_PATH_BYTES
  );
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    fail("invalid-statistics");
  }
  return value as number;
}

function requirePositiveU32(value: unknown, code: JscpdReportErrorCode): number {
  const number = requireU32(value, code);
  if (number === 0) {
    fail(code);
  }
  return number;
}

function requireU32(value: unknown, code: JscpdReportErrorCode): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_U32 ||
    Object.is(value, -0)
  ) {
    fail(code);
  }
  return value as number;
}

function requirePercentage(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100 ||
    Object.is(value, -0)
  ) {
    fail("invalid-statistics");
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isPathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: JscpdReportErrorCode): never {
  throw new ReportValidationError(code);
}
