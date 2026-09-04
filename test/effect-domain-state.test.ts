import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementLayer, JscpdAcknowledgements } from "../src/acknowledgements.js";
import { createJscpdBaselineLayer, JscpdBaseline } from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import { createJscpdChangedFilesLayer, JscpdChangedFiles } from "../src/changed-files.js";
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
} from "./support/effect-layers.js";

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
    async probe() {
      return {
        status: "available",
        executable: "jscpd",
        version: "5.1.2",
        major: 5,
      };
    },
    invalidate() {},
    dispose() {},
  };
}

function adapterService(run: JscpdService["run"]): JscpdService {
  return { run, invalidate() {}, async dispose() {} };
}

describe("Effect domain state services", () => {
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

  it("completes active baseline waiters as lifecycle-cancelled on invalidation", async () => {
    const capability = availableCapabilityService();
    const run = vi.fn(
      (request: JscpdRunRequest<JscpdScanReport>) =>
        new Promise<{ status: "cancelled" }>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), {
            once: true,
          });
        }),
    ) as unknown as JscpdService["run"];
    const adapter = adapterService(run);
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.merge(createJscpdBaselineLayer(capability, adapter), filesystem.layer);
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
    ) as unknown as JscpdService["run"];
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.merge(
      createJscpdBaselineLayer(availableCapabilityService(), adapterService(run)),
      filesystem.layer,
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
    const adapter = adapterService(run as unknown as JscpdService["run"]);
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const layers = Layer.merge(
      createJscpdBaselineLayer(availableCapabilityService(), adapter),
      filesystem.layer,
    );
    const program = Effect.flatMap(JscpdBaseline, (baseline) =>
      baseline.start({ cwd: project, enabled: true, timeoutMs: 1_000, hasPriorChanges: false }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "accepted", outcome: "clean" });
    expect(run).toHaveBeenCalledOnce();
  });
});
