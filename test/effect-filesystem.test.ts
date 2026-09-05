import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexJscpdCloneReportEffect } from "../src/clone-identity.js";
import {
  createJscpdConfigLayer,
  JscpdConfiguration,
  loadJscpdConfigEffect,
} from "../src/config.js";
import { JscpdFileSystemFailure } from "../src/effect/errors.js";
import { JscpdFileSystemLive, readBoundedFileWith } from "../src/effect/filesystem.js";
import { JscpdFileSystem } from "../src/effect/services.js";
import { evaluateJscpdFallowCoexistenceEffect } from "../src/fallow.js";
import { consumeJscpdV5JsonReportEffect } from "../src/jscpd-report.js";
import { canonicalDirectoryEffect } from "../src/path-utils.js";
import type { JscpdScanReport } from "../src/types.js";
import { createJscpdFileSystemTestLayer } from "./support/effect-layers.js";

const encoder = new TextEncoder();
const project = "/project";
const projectEntry = { path: project, kind: "directory" as const };
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Effect filesystem and decoding boundaries", () => {
  it("waits for an in-flight bounded read before closing on interruption", async () => {
    let releaseRead = () => {};
    let enteredResolve = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const close = vi.fn(async () => undefined);
    const file = {
      stat: async () => ({ isFile: () => true, size: 1 }) as Stats,
      read: async () => {
        enteredResolve();
        await readGate;
        return { bytesRead: 0, buffer: Buffer.alloc(2) };
      },
      close,
    } as unknown as FileHandle;
    const controller = new AbortController();
    const running = Effect.runPromiseExit(
      readBoundedFileWith(
        {
          path: "/report.json",
          maxBytes: 1,
          regularFileOnly: true,
          noFollow: true,
          limitSubject: "report",
        },
        Effect.succeed(file),
      ),
      { signal: controller.signal },
    );
    await entered;

    controller.abort();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    releaseRead();

    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a handle acquired after interruption without starting a read", async () => {
    let releaseAcquire = (_file: FileHandle) => {};
    let acquiringResolve = () => {};
    const acquiring = new Promise<void>((resolve) => {
      acquiringResolve = resolve;
    });
    const acquired = new Promise<FileHandle>((resolve) => {
      releaseAcquire = resolve;
    });
    const close = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({ isFile: () => true, size: 0 }) as Stats);
    const file = { stat, close } as unknown as FileHandle;
    const controller = new AbortController();
    const acquire = Effect.tryPromise({
      try: () => {
        acquiringResolve();
        return acquired;
      },
      catch: () => new JscpdFileSystemFailure({ operation: "read", reason: "io" }),
    });
    const running = Effect.runPromiseExit(
      readBoundedFileWith(
        {
          path: "/report.json",
          maxBytes: 1,
          regularFileOnly: true,
          noFollow: true,
          limitSubject: "report",
        },
        acquire,
      ),
      { signal: controller.signal },
    );
    await acquiring;

    controller.abort();
    releaseAcquire(file);

    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not consult the filesystem before project trust", async () => {
    const filesystem = createJscpdFileSystemTestLayer();

    const result = await Effect.runPromise(
      loadJscpdConfigEffect({ cwd: project, trusted: false }).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(result.trusted).toBe(false);
    expect(filesystem.operations).toEqual([]);
  });

  it("rejects one decoded configuration atomically before merging the next layer", async () => {
    const projectConfig = join(project, CONFIG_DIR_NAME, "jscpd-guardrail.json");
    const localConfig = join(project, CONFIG_DIR_NAME, "jscpd-guardrail.local.json");
    const filesystem = createJscpdFileSystemTestLayer([
      projectEntry,
      { path: projectConfig, bytes: encoder.encode('{ "maxFindings": 4, "future": true }') },
      { path: localConfig, bytes: encoder.encode(JSON.stringify({ maxFindings: 4 })) },
    ]);
    const layers = Layer.merge(createJscpdConfigLayer(), filesystem.layer);
    const program = Effect.gen(function* () {
      const config = yield* JscpdConfiguration;
      const loaded = yield* config.load({ cwd: project, trusted: true });
      return { loaded, current: yield* config.current };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result.loaded.config.maxFindings).toBe(4);
    expect(result.current).toBe(result.loaded);
    expect(result.loaded.sources).toEqual(["defaults", "local"]);
    expect(result.loaded.diagnostics).toEqual([
      expect.objectContaining({ source: "project", code: "unknown-field" }),
    ]);
  });

  it("decodes a clean report and validates its project through the injected layer", async () => {
    const filesystem = createJscpdFileSystemTestLayer([projectEntry]);

    const result = await Effect.runPromise(
      consumeJscpdV5JsonReportEffect(cleanReportBytes(), project).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(result.status).toBe("no-findings");
    expect(filesystem.operations).toEqual([`canonicalize:${project}`, `metadata:${project}`]);
  });

  it("keeps pure report rejection ahead of filesystem access", async () => {
    const filesystem = createJscpdFileSystemTestLayer([projectEntry]);

    const result = await Effect.runPromise(
      consumeJscpdV5JsonReportEffect(encoder.encode("{ invalid"), project).pipe(
        Effect.provide(filesystem.layer),
      ),
    );

    expect(result).toEqual({ status: "rejected", reason: "malformed-json" });
    expect(filesystem.operations).toEqual([]);
  });

  it("normalizes report source paths through the deterministic service", async () => {
    const filesystem = createJscpdFileSystemTestLayer([
      projectEntry,
      { path: join(project, "lib/b.ts"), bytes: new Uint8Array(267) },
      { path: join(project, "src/a.ts"), bytes: new Uint8Array(267) },
    ]);
    const bytes = await readFile(new URL("./fixtures/jscpd-v5/findings.json", import.meta.url));

    const result = await Effect.runPromise(
      consumeJscpdV5JsonReportEffect(bytes, project).pipe(Effect.provide(filesystem.layer)),
    );

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.value.clonePairs[0]?.occurrences.map(({ path }) => path)).toEqual([
        "lib/b.ts",
        "src/a.ts",
      ]);
    }
  });

  it("indexes exact source blocks through the deterministic service", async () => {
    const source = encoder.encode("same bounded source block");
    const filesystem = createJscpdFileSystemTestLayer([
      projectEntry,
      { path: join(project, "a.ts"), bytes: source },
      { path: join(project, "b.ts"), bytes: source },
    ]);
    const report = cloneReport(source.byteLength);
    const program = Effect.gen(function* () {
      const directory = yield* canonicalDirectoryEffect(project);
      const snapshot = yield* indexJscpdCloneReportEffect(report, project);
      return { directory, snapshot };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(filesystem.layer)));

    expect(result.directory).toBe(project);
    expect(result.snapshot.status).toBe("accepted");
    expect(result.snapshot.groups[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(filesystem.operations).toContain(`read:${join(project, "a.ts")}`);
  });

  it("inspects only bounded supported Fallow signals through the injected service", async () => {
    const manifest = { scripts: { duplicates: "fallow dupes" } };
    const filesystem = createJscpdFileSystemTestLayer([
      projectEntry,
      { path: join(project, "package.json"), bytes: encoder.encode(JSON.stringify(manifest)) },
    ]);

    const result = await Effect.runPromise(
      evaluateJscpdFallowCoexistenceEffect({
        cwd: project,
        trusted: true,
        fallowToolAvailable: false,
      }).pipe(Effect.provide(filesystem.layer)),
    );

    expect(result.status).toBe("detected");
    expect(result.signals).toContain("duplication-script");
  });

  it("reads exact bounded ranges and rejects files over the declared limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-jscpd-effect-fs-range-"));
    temporaryRoots.push(root);
    const source = join(root, "source.txt");
    await writeFile(source, "0123456789");
    const program = Effect.flatMap(JscpdFileSystem, (filesystem) =>
      Effect.all({
        range: filesystem.read({
          path: source,
          maxBytes: 4,
          regularFileOnly: true,
          noFollow: true,
          offset: 3,
          length: 4,
          limitSubject: "report",
        }),
        oversized: Effect.exit(
          filesystem.read({
            path: source,
            maxBytes: 4,
            regularFileOnly: true,
            noFollow: true,
            limitSubject: "configuration",
          }),
        ),
      }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(JscpdFileSystemLive)));

    expect(new TextDecoder().decode(result.range)).toBe("3456");
    expect(Exit.isFailure(result.oversized)).toBe(true);
    if (Exit.isFailure(result.oversized)) {
      expect(Cause.pretty(result.oversized.cause)).toContain("JscpdLimitExceeded");
    }
  });

  it("uses no-follow bounded reads in the live service", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-jscpd-effect-fs-"));
    temporaryRoots.push(root);
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await mkdir(join(root, "directory"));
    await writeFile(target, "{}");
    await symlink(target, link);
    const program = Effect.flatMap(JscpdFileSystem, (filesystem) =>
      filesystem.read({
        path: link,
        maxBytes: 64,
        regularFileOnly: true,
        noFollow: true,
        limitSubject: "configuration",
      }),
    );

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(JscpdFileSystemLive)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("JscpdFileSystemFailure");
    }
  });
});

function cleanReportBytes(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      duplicates: [],
      statistics: {
        detectionDate: "2026-09-01T17:40:00.000Z",
        formats: {},
        total: {
          clones: 0,
          duplicatedLines: 0,
          duplicatedTokens: 0,
          lines: 0,
          newClones: 0,
          newDuplicatedLines: 0,
          percentage: 0,
          percentageTokens: 0,
          sources: 0,
          tokens: 0,
        },
      },
    }),
  );
}

function cloneReport(length: number): JscpdScanReport {
  const statistics = {
    lines: 2,
    tokens: 2,
    sources: 2,
    clones: 1,
    duplicatedLines: 1,
    duplicatedTokens: 1,
    percentage: 50,
    percentageTokens: 50,
    newDuplicatedLines: 0,
    newClones: 0,
  };
  const location = (path: string) =>
    Object.freeze({
      path,
      start: Object.freeze({ line: 1, column: 0, offset: 0 }),
      end: Object.freeze({ line: 1, column: length, offset: length }),
    });
  return Object.freeze({
    statistics: Object.freeze({
      detectionDate: "2026-09-01T17:40:00.000Z",
      total: Object.freeze(statistics),
      formats: Object.freeze([Object.freeze({ format: "typescript", ...statistics })]),
    }),
    clonePairs: Object.freeze([
      Object.freeze({
        format: "typescript",
        lines: 1,
        tokens: 1,
        occurrences: Object.freeze([location("a.ts"), location("b.ts")] as const),
      }),
    ]),
  });
}
