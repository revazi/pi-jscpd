import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementLayer, JscpdAcknowledgements } from "../src/acknowledgements.js";
import {
  createJscpdBaselineLayer,
  createJscpdBaselineService,
  JscpdBaseline,
} from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import {
  createJscpdChangedFilesLayer,
  createJscpdChangedFileTracker,
  JscpdChangedFiles,
} from "../src/changed-files.js";
import { JscpdFileSystem } from "../src/effect/services.js";
import type { JscpdRunRequest, JscpdService } from "../src/jscpd.js";
import {
  JSCPD_SESSION_STATE_VERSION,
  type JscpdPersistedSessionState,
  persistJscpdSessionStateEffect,
} from "../src/session-state.js";
import type { JscpdScanReport } from "../src/types.js";
import { createJscpdVerificationLayer, JscpdVerification } from "../src/verification.js";
import {
  createJscpdFileSystemTestLayer,
  createJscpdPiPortTestLayer,
  createJscpdProcessTestLayer,
} from "./support/effect-layers.js";
import { type JscpdPromiseRun, jscpdServiceFromPromise } from "./support/jscpd-service.js";

const project = "/project";
const cleanReport: JscpdScanReport = {
  statistics: {
    total: {
      lines: 0,
      tokens: 0,
      sources: 0,
      clones: 0,
      duplicatedLines: 0,
      duplicatedTokens: 0,
      percentage: 0,
      percentageTokens: 0,
      newDuplicatedLines: 0,
      newClones: 0,
    },
    formats: [],
  },
  clonePairs: [],
};

function finding(index: number) {
  return {
    fingerprint: index.toString(16).padStart(64, "0"),
    paths: [`src/${index}.ts`, "src/shared.ts"] as const,
  };
}

function mutation(path: string) {
  return { toolName: "write", input: { path }, isError: false };
}

function availableCapabilityService(): JscpdCapabilityService {
  return {
    probeEffect: () =>
      Effect.succeed({
        status: "available",
        executable: "jscpd",
        version: "5.1.2",
        major: 5,
      }),
    invalidate() {},
    dispose() {},
  };
}

function adapterService(run: JscpdPromiseRun): JscpdService {
  return jscpdServiceFromPromise(run);
}

describe("Effect domain state services", () => {
  it("does not change baseline state until the native start effect executes", async () => {
    const service = createJscpdBaselineService(availableCapabilityService(), {
      runEffect: () => Effect.die("disabled capture must not run"),
      invalidate() {},
      disposeEffect: () => Effect.void,
    });
    const filesystem = createJscpdFileSystemTestLayer([]);
    const process = createJscpdProcessTestLayer([]);
    const start = service.startEffect({
      cwd: project,
      enabled: false,
      timeoutMs: 100,
      hasPriorChanges: false,
    });
    expect(service.current()).toEqual({ status: "unstarted" });
    await expect(
      Effect.runPromise(start.pipe(Effect.provide(Layer.merge(filesystem.layer, process.layer)))),
    ).resolves.toEqual({ status: "unavailable", reason: "disabled" });
    await expect(Effect.runPromise(service.waitEffect)).resolves.toEqual(service.current());
    expect(filesystem.operations).toEqual([]);
    expect(process.requests).toEqual([]);
  });
  it("keeps native tracker construction lazy and uses only the injected filesystem", async () => {
    const tracker = createJscpdChangedFileTracker();
    const filesystem = createJscpdFileSystemTestLayer([
      { path: project, kind: "directory" },
      { path: `${project}/a.ts`, bytes: new Uint8Array([1]) },
    ]);
    const start = tracker.startEffect(project, ["restored.ts"]);
    expect(tracker.files()).toEqual([]);
    expect(filesystem.operations).toEqual([]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* start;
        const added = yield* tracker.recordToolResultEffect(mutation("a.ts"), project);
        const repeated = yield* tracker.recordToolResultEffect(mutation("a.ts"), project);
        const path = yield* tracker.recordToolResultPathEffect(mutation("a.ts"), project);
        return { added, repeated, path, files: yield* tracker.filesEffect };
      }).pipe(Effect.provide(filesystem.layer)),
    );
    expect(result).toEqual({
      added: true,
      repeated: false,
      path: "a.ts",
      files: ["a.ts", "restored.ts"],
    });
  });

  it("does not let pending native tracker startup restore roots after reset", async () => {
    const tracker = createJscpdChangedFileTracker();
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* JscpdFileSystem;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = {
          ...live,
          canonicalize: (path: string) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.zipRight(live.canonicalize(path)),
            ),
        };
        const startup = yield* Effect.fork(
          tracker
            .startEffect(project, ["old.ts"])
            .pipe(Effect.provideService(JscpdFileSystem, delayed)),
        );
        yield* Deferred.await(entered);
        tracker.reset();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(startup);
        expect(tracker.files()).toEqual([]);
        expect(yield* tracker.recordToolResultEffect(mutation("a.ts"), project)).toBe(false);
        expect(filesystem.operations).not.toContain(`canonicalize:${project}/a.ts`);
      }).pipe(Effect.provide(filesystem.layer)),
    );
  });
  it("serializes acknowledgement transactions against one revision", async () => {
    const first = finding(1);
    const second = finding(2);
    const program = Effect.gen(function* () {
      const acknowledgements = yield* JscpdAcknowledgements;
      const revision = yield* acknowledgements.revision;
      return yield* Effect.all(
        [
          acknowledgements.reconcile(revision, [first, second], [first]),
          acknowledgements.reconcile(revision, [first, second], [second]),
        ],
        { concurrency: "unbounded" },
      );
    });

    const results = await Effect.runPromise(
      program.pipe(Effect.provide(createJscpdAcknowledgementLayer())),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("isolates verification checkpoints after lifecycle reset", async () => {
    const accepted = { status: "accepted", groups: [], omittedGroups: 0 } as const;
    const program = Effect.gen(function* () {
      const verification = yield* JscpdVerification;
      const staleScope = yield* verification.scope;
      yield* verification.reset;
      return yield* verification.compareAndRemember("project", '["."]', accepted, staleScope);
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(createJscpdVerificationLayer())),
    );

    expect(result).toMatchObject({ state: "unavailable", reason: "lifecycle-changed" });
  });

  it("attributes concurrent changed files through one project-scoped state owner", async () => {
    const filesystem = createJscpdFileSystemTestLayer([
      { path: project, kind: "directory" },
      { path: `${project}/a.ts`, bytes: new Uint8Array([1]) },
      { path: `${project}/b.ts`, bytes: new Uint8Array([2]) },
    ]);
    const layers = Layer.merge(createJscpdChangedFilesLayer(), filesystem.layer);
    const program = Effect.gen(function* () {
      const changed = yield* JscpdChangedFiles;
      yield* changed.start(project);
      const added = yield* Effect.all(
        [
          changed.recordToolResult(mutation("a.ts"), project),
          changed.recordToolResult(mutation("b.ts"), project),
        ],
        { concurrency: "unbounded" },
      );
      return { added, files: yield* changed.files };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result.added).toEqual([true, true]);
    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });

  it("reads changed-file ownership when the Effect executes rather than when composed", async () => {
    const filesystem = createJscpdFileSystemTestLayer([
      { path: project, kind: "directory" },
      { path: `${project}/a.ts`, bytes: new Uint8Array([1]) },
    ]);
    const layers = Layer.merge(createJscpdChangedFilesLayer(), filesystem.layer);
    const program = Effect.gen(function* () {
      const changed = yield* JscpdChangedFiles;
      const recordAfterStart = changed.recordToolResult(mutation("a.ts"), project);
      yield* changed.start(project);
      return {
        added: yield* recordAfterStart,
        files: yield* changed.files,
      };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toEqual({ added: true, files: ["a.ts"] });
  });

  it("completes active baseline waiters as lifecycle-cancelled on invalidation", async () => {
    const capability = availableCapabilityService();
    const run = vi.fn(
      (request: JscpdRunRequest<JscpdScanReport>) =>
        new Promise<{ status: "cancelled" }>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), {
            once: true,
          });
        }),
    ) as unknown as JscpdPromiseRun;
    const adapter = adapterService(run);
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.mergeAll(
      createJscpdBaselineLayer(capability, adapter),
      filesystem.layer,
      createJscpdProcessTestLayer([]).layer,
    );
    const program = Effect.gen(function* () {
      const baseline = yield* JscpdBaseline;
      const capture = yield* Effect.fork(
        baseline.start({ cwd: project, enabled: true, timeoutMs: 1_000, hasPriorChanges: false }),
      );
      yield* Effect.yieldNow();
      const waiter = yield* Effect.fork(baseline.wait);
      yield* Effect.yieldNow();
      yield* baseline.invalidate;
      return yield* Effect.all([Fiber.join(capture), Fiber.join(waiter)]);
    });

    const results = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(results).toEqual([
      { status: "cancelled", stage: "lifecycle" },
      { status: "cancelled", stage: "lifecycle" },
    ]);
  });

  it("persists bounded snapshots through the injected Pi port and keeps failures typed", async () => {
    const pi = createJscpdPiPortTestLayer();
    const state = {
      version: JSCPD_SESSION_STATE_VERSION,
      modeOverride: null,
      lastCheck: { state: "never" as const },
      changedFiles: [],
      acknowledgements: { identityVersion: 1 as const, findings: [] },
    } satisfies JscpdPersistedSessionState;
    await Effect.runPromise(persistJscpdSessionStateEffect(state).pipe(Effect.provide(pi.layer)));
    pi.failNext("persistence");

    const failed = await Effect.runPromiseExit(
      persistJscpdSessionStateEffect(state).pipe(Effect.provide(pi.layer)),
    );

    expect(pi.sessionEntries).toEqual([{ customType: "pi-jscpd/session-state", data: state }]);
    expect(String(failed)).toContain("JscpdPersistenceFailure");
  });

  it("settles baseline state when the calling fiber is interrupted", async () => {
    const run = vi.fn(
      (request: JscpdRunRequest<JscpdScanReport>) =>
        new Promise<{ status: "cancelled" }>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), {
            once: true,
          });
        }),
    ) as unknown as JscpdPromiseRun;
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.mergeAll(
      createJscpdBaselineLayer(availableCapabilityService(), adapterService(run)),
      filesystem.layer,
      createJscpdProcessTestLayer([]).layer,
    );
    const program = Effect.gen(function* () {
      const baseline = yield* JscpdBaseline;
      const capture = yield* Effect.fork(
        baseline.start({ cwd: project, enabled: true, timeoutMs: 1_000, hasPriorChanges: false }),
      );
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(capture);
      return yield* baseline.current;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toEqual({ status: "cancelled", stage: "lifecycle" });
  });

  it("captures an accepted baseline through the Effect service", async () => {
    const run = vi.fn(async () => ({ status: "no-findings", value: cleanReport }) as const);
    const adapter = adapterService(run as unknown as JscpdPromiseRun);
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.mergeAll(
      createJscpdBaselineLayer(availableCapabilityService(), adapter),
      filesystem.layer,
      createJscpdProcessTestLayer([]).layer,
    );
    const program = Effect.flatMap(JscpdBaseline, (baseline) =>
      baseline.start({ cwd: project, enabled: true, timeoutMs: 1_000, hasPriorChanges: false }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "accepted", outcome: "clean" });
    expect(run).toHaveBeenCalledOnce();
  });
});
