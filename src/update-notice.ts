import { readFile } from "node:fs/promises";
import { get } from "node:https";
import { Effect } from "effect";

const PACKAGE_NAME = "pi-jscpd";
const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_COMMAND = `pi update npm:${PACKAGE_NAME}`;
const DISABLE_UPDATE_ENV = "PI_JSCPD_DISABLE_UPDATE_NOTICE";
const UPDATE_CHECK_ENV = "PI_JSCPD_UPDATE_CHECK";
const UPDATE_CHECK_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface JscpdUpdateNoticeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly currentVersionEffect?: Effect.Effect<string | undefined, unknown>;
  readonly latestVersionEffect?: Effect.Effect<string | undefined, unknown>;
  readonly timeoutMs?: number;
}

export interface JscpdUpdateNoticeService {
  /** Resolve at most one warning for this extension instance; failures stay silent. */
  readonly noticeEffect: Effect.Effect<string | undefined>;
}

/** Best-effort npm metadata check. It never downloads or installs package content. */
export function createJscpdUpdateNoticeService(
  options: JscpdUpdateNoticeOptions = {},
): JscpdUpdateNoticeService {
  const environment = options.environment ?? process.env;
  let shown = false;

  return {
    noticeEffect: Effect.suspend(() => {
      if (shown || isUpdateCheckDisabled(environment)) return Effect.succeed(undefined);
      shown = true;

      const currentVersion = recoverLookup(
        options.currentVersionEffect ?? readCurrentVersionEffect(),
      );
      const latestVersion = recoverLookup(
        options.latestVersionEffect ?? fetchLatestVersionEffect(),
      ).pipe(
        Effect.timeoutTo({
          duration: options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
          onSuccess: (version) => version,
          onTimeout: () => undefined,
        }),
      );

      return currentVersion.pipe(
        Effect.flatMap((current) =>
          current
            ? latestVersion.pipe(Effect.map((latest) => buildUpdateNotice(current, latest)))
            : Effect.succeed(undefined),
        ),
      );
    }),
  };
}

function readCurrentVersionEffect(): Effect.Effect<string | undefined, Error> {
  return Effect.tryPromise({
    try: () => readFile(PACKAGE_JSON_URL, "utf8"),
    catch: () => new Error("Unable to read package metadata."),
  }).pipe(Effect.map(parsePackageVersion));
}

function parsePackageVersion(source: string): string | undefined {
  try {
    const value = JSON.parse(source) as { version?: unknown };
    return typeof value.version === "string" && VERSION_PATTERN.test(value.version)
      ? value.version
      : undefined;
  } catch {
    return undefined;
  }
}

function fetchLatestVersionEffect(): Effect.Effect<string | undefined, Error> {
  return Effect.async((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<string | undefined, Error>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const request = get(NPM_LATEST_URL, { headers: { accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        settle(Effect.succeed(undefined));
        return;
      }

      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        settle(Effect.succeed(undefined));
        return;
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (value: Buffer) => {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy();
          settle(Effect.succeed(undefined));
          return;
        }
        chunks.push(value);
      });
      response.once("end", () => {
        settle(Effect.succeed(parseLatestVersionBytes(chunks, total)));
      });
      response.once("error", () => {
        settle(Effect.fail(new Error("Unable to read npm package metadata.")));
      });
    });
    request.once("error", () => {
      settle(Effect.fail(new Error("Unable to check npm package metadata.")));
    });

    return Effect.sync(() => {
      settled = true;
      request.destroy();
    });
  });
}

function parseLatestVersionBytes(chunks: readonly Uint8Array[], total: number): string | undefined {
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source) as { version?: unknown };
    return typeof value.version === "string" && VERSION_PATTERN.test(value.version)
      ? value.version
      : undefined;
  } catch {
    return undefined;
  }
}

function recoverLookup(
  effect: Effect.Effect<string | undefined, unknown>,
): Effect.Effect<string | undefined> {
  return effect.pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

function buildUpdateNotice(
  currentVersion: string,
  latestVersion: string | undefined,
): string | undefined {
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return undefined;
  return `${PACKAGE_NAME} ${latestVersion} is available (you have ${currentVersion}). Update: ${UPDATE_COMMAND}`;
}

function compareVersions(left: string, right: string): number {
  const leftMatch = VERSION_PATTERN.exec(left);
  const rightMatch = VERSION_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) return 0;

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return Math.sign(difference);
  }

  const leftPrerelease = left.includes("-");
  const rightPrerelease = right.includes("-");
  if (leftPrerelease === rightPrerelease) return 0;
  return leftPrerelease ? -1 : 1;
}

function isUpdateCheckDisabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const offline = environment.PI_OFFLINE;
  if (offline !== undefined && !isFalseLike(offline)) return true;

  const disabled = environment[DISABLE_UPDATE_ENV];
  if (disabled !== undefined) return !isFalseLike(disabled);

  const enabled = environment[UPDATE_CHECK_ENV];
  return enabled !== undefined && isFalseLike(enabled);
}

function isFalseLike(value: string): boolean {
  return ["0", "false", "off", "no"].includes(value.toLocaleLowerCase());
}
