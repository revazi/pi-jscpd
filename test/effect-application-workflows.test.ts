import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createJscpdAcknowledgementTracker,
  type JscpdAcknowledgementTracker,
} from "../src/acknowledgements.js";
import type { JscpdBaselineService } from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import { createJscpdChangedWorkflowLayer, JscpdChangedWorkflow } from "../src/changed.js";
import type { JscpdChangedFileTracker } from "../src/changed-files.js";
import type { JscpdConfigService } from "../src/config.js";
import { JscpdFileSystemFailure } from "../src/effect/errors.js";
import { JscpdTestEffectRuntime } from "../src/effect/runtime-boundary.js";
import {
  type JscpdFileSystem,
  JscpdFileSystem as JscpdFileSystemTag,
  JscpdProcess,
} from "../src/effect/services.js";
import { createJscpdFallowCoexistenceLayer, JscpdFallowWorkflow } from "../src/fallow.js";
import type { JscpdService } from "../src/jscpd.js";
import { createJscpdScanWorkflowLayer, JscpdScanWorkflow } from "../src/scan.js";
import {
  createJscpdSessionModeLayer,
  createJscpdSessionModeService,
  createJscpdStatusAwareExecutor,
  createJscpdStatusService,
  createJscpdStatusWorkflowLayer,
  JscpdSessionMode,
  JscpdStatusWorkflow,
} from "../src/status.js";
import type { JscpdScanReport } from "../src/types.js";
import {
  createJscpdFileSystemTestLayer,
  createJscpdProcessTestLayer,
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

function capability(): JscpdCapabilityService {
  return {
    async probe() {
      return { status: "available", executable: "jscpd", version: "5.1.2", major: 5 };
    },
    invalidate() {},
    dispose() {},
  };
}

function adapter(): JscpdService {
  return {
    runEffect: (() =>
      Effect.succeed({ status: "no-findings", value: cleanReport })) as JscpdService["runEffect"],
    invalidate() {},
    disposeEffect: () => Effect.void,
  };
}

function platformLayer() {
  const filesystem = createJscpdFileSystemTestLayer([
    { path: project, kind: "directory" },
    { path: `${project}/src`, kind: "directory" },
  ]);
  return Layer.merge(filesystem.layer, createJscpdProcessTestLayer([]).layer);
}

describe("Effect application workflows", () => {
  it("composes safe scan scope, capability, adapter, and presentation as one Effect", async () => {
    const layers = Layer.merge(
      createJscpdScanWorkflowLayer(capability(), adapter()),
      platformLayer(),
    );
    const program = Effect.flatMap(JscpdScanWorkflow, (scan) =>
      scan.execute({ command: "scan", args: ["src"] }, { cwd: project }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "completed", outcome: "clean" });
  });

  it("stops scope resolution at the first rejected target", async () => {
    const filesystem = createJscpdFileSystemTestLayer([
      { path: project, kind: "directory" },
      { path: `${project}/src`, kind: "directory" },
    ]);
    const layers = Layer.mergeAll(
      createJscpdScanWorkflowLayer(capability(), adapter()),
      filesystem.layer,
      createJscpdProcessTestLayer([]).layer,
    );
    const program = Effect.flatMap(JscpdScanWorkflow, (scan) =>
      scan.execute({ command: "scan", args: ["missing", "src"] }, { cwd: project }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "failed", reason: "unsupported-path" });
    expect(filesystem.operations).not.toContain(`canonicalize:${project}/src`);
  });

  it("composes native capability and adapter effects", async () => {
    const nativeCapability: JscpdCapabilityService = {
      async probe() {
        throw new Error("compatibility probe must not run");
      },
      probeEffect: () =>
        Effect.succeed({
          status: "available" as const,
          executable: "jscpd" as const,
          version: "5.1.2",
          major: 5,
        }),
      invalidate() {},
      dispose() {},
    };
    const nativeAdapter: JscpdService = {
      runEffect: (() =>
        Effect.succeed({
          status: "no-findings" as const,
          value: cleanReport,
        })) as JscpdService["runEffect"],
      invalidate() {},
      disposeEffect: () => Effect.void,
    };
    const layers = Layer.merge(
      createJscpdScanWorkflowLayer(nativeCapability, nativeAdapter),
      platformLayer(),
    );
    const program = Effect.flatMap(JscpdScanWorkflow, (scan) =>
      scan.execute({ command: "scan", args: ["src"] }, { cwd: project }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "completed", outcome: "clean" });
  });

  it("composes baseline comparison and acknowledgement reconciliation as one Effect", async () => {
    const baseline: JscpdBaselineService = {
      startEffect: () => Effect.sync(() => baseline.current()),
      waitEffect: Effect.succeed({
        status: "accepted",
        outcome: "clean",
        report: cleanReport,
        snapshot: { status: "accepted", groups: [], omittedGroups: 0 },
      }),
      disable() {},
      invalidate() {},
      current() {
        return {
          status: "accepted",
          outcome: "clean",
          report: cleanReport,
          snapshot: { status: "accepted", groups: [], omittedGroups: 0 },
        };
      },
    };
    const changedFiles: JscpdChangedFileTracker = {
      startEffect: () => Effect.void,
      reset() {},
      recordToolResultEffect: () => Effect.succeed(false),
      recordToolResultPathEffect: () => Effect.succeed(undefined),
      files: () => {
        throw new Error("compatibility changed-files read must not run");
      },
      filesEffect: Effect.succeed(["src/a.ts"]),
    };
    const layers = Layer.merge(
      createJscpdChangedWorkflowLayer(
        capability(),
        adapter(),
        baseline,
        changedFiles,
        createJscpdAcknowledgementTracker(),
      ),
      platformLayer(),
    );
    const program = Effect.flatMap(JscpdChangedWorkflow, (changed) =>
      changed.execute({ cwd: project }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({ status: "changed", outcome: "clean", scanPerformed: true });
  });

  it("rejects queued changed work captured before a branch reset", async () => {
    const baseAcknowledgements = createJscpdAcknowledgementTracker();
    let observeNextScope = false;
    let adapterCalls = 0;
    const program = Effect.gen(function* () {
      const adapterEntered = yield* Deferred.make<void>();
      const releaseAdapter = yield* Deferred.make<void>();
      const queuedScopeCaptured = yield* Deferred.make<void>();
      const acknowledgements = {
        ...baseAcknowledgements,
        scopeEffect: Effect.suspend(() => {
          const scope = baseAcknowledgements.scope();
          if (!observeNextScope) return Effect.succeed(scope);
          observeNextScope = false;
          return Deferred.succeed(queuedScopeCaptured, undefined).pipe(Effect.as(scope));
        }),
      } satisfies JscpdAcknowledgementTracker;
      const baseline: JscpdBaselineService = {
        startEffect: () => Effect.sync(() => baseline.current()),
        waitEffect: Effect.succeed({
          status: "accepted",
          outcome: "clean",
          report: cleanReport,
          snapshot: { status: "accepted", groups: [], omittedGroups: 0 },
        }),
        disable() {},
        invalidate() {},
        current: () => ({
          status: "accepted",
          outcome: "clean",
          report: cleanReport,
          snapshot: { status: "accepted", groups: [], omittedGroups: 0 },
        }),
      };
      const changedFiles: JscpdChangedFileTracker = {
        startEffect: () => Effect.void,
        reset() {},
        recordToolResultEffect: () => Effect.succeed(false),
        recordToolResultPathEffect: () => Effect.succeed(undefined),
        files: () => ["src/a.ts"],
        filesEffect: Effect.succeed(["src/a.ts"]),
      };
      const runEffect = (() => {
        adapterCalls += 1;
        return Deferred.succeed(adapterEntered, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseAdapter)),
          Effect.as({ status: "no-findings" as const, value: cleanReport }),
        );
      }) as NonNullable<JscpdService["runEffect"]>;
      const nativeAdapter: JscpdService = {
        runEffect,
        invalidate() {},
        disposeEffect: () => Effect.void,
      };
      const layers = Layer.merge(
        createJscpdChangedWorkflowLayer(
          capability(),
          nativeAdapter,
          baseline,
          changedFiles,
          acknowledgements,
        ),
        platformLayer(),
      );
      return yield* Effect.gen(function* () {
        const changed = yield* JscpdChangedWorkflow;
        const first = yield* Effect.fork(changed.execute({ cwd: project }));
        yield* Deferred.await(adapterEntered);
        observeNextScope = true;
        const queued = yield* Effect.fork(changed.execute({ cwd: project }));
        yield* Deferred.await(queuedScopeCaptured);
        baseAcknowledgements.reset();
        yield* Deferred.succeed(releaseAdapter, undefined);
        return yield* Effect.all([Fiber.join(first), Fiber.join(queued)]);
      }).pipe(Effect.provide(layers));
    });

    const results = await Effect.runPromise(program);

    expect(results).toEqual([
      expect.objectContaining({ status: "changed-unavailable", reason: "baseline-cancelled" }),
      expect.objectContaining({ status: "changed-unavailable", reason: "baseline-cancelled" }),
    ]);
    expect(adapterCalls).toBe(1);
  });

  it("keeps status inspection and recording in one Effect-owned state service", async () => {
    const config: JscpdConfigService = {
      loadEffect: () => Effect.sync(() => config.current()),
      current() {
        return {
          config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
          sources: ["defaults"],
          diagnostics: [],
          trusted: true,
        };
      },
    };
    const mode = createJscpdSessionModeService();
    const layers = Layer.mergeAll(
      createJscpdStatusWorkflowLayer(capability(), config, mode),
      createJscpdSessionModeLayer(mode),
      createJscpdProcessTestLayer([]).layer,
    );
    const program = Effect.gen(function* () {
      const status = yield* JscpdStatusWorkflow;
      const sessionMode = yield* JscpdSessionMode;
      yield* sessionMode.disable;
      yield* status.record({
        status: "failed",
        reason: "scan-timed-out",
        message: "timed out",
      });
      return yield* status.inspect({ cwd: project });
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result).toMatchObject({
      status: "status",
      mode: "disabled",
      modeSource: "session",
      lastCheck: { state: "failed", reason: "scan-timed-out" },
    });
  });

  it("leaves status process requirements injectable by the application layer", async () => {
    const process = createJscpdProcessTestLayer([
      {
        status: "success",
        result: {
          exitCode: 0,
          stdout: new TextEncoder().encode("5.1.2"),
          stderr: new Uint8Array(),
        },
      },
    ]);
    const nativeCapability: JscpdCapabilityService = {
      async probe() {
        throw new Error("compatibility probe must not run");
      },
      probeEffect: () =>
        Effect.flatMap(JscpdProcess, (runner) =>
          runner.run({
            stage: "probe",
            executable: "jscpd",
            args: ["--version"],
            cwd: project,
            timeoutMs: 2_000,
            maxOutputBytes: 4_096,
          }),
        ).pipe(
          Effect.match({
            onFailure: () =>
              ({ status: "failed", executable: "jscpd", reason: "execution-error" }) as const,
            onSuccess: () =>
              ({
                status: "available",
                executable: "jscpd",
                version: "5.1.2",
                major: 5,
              }) as const,
          }),
        ),
      invalidate() {},
      dispose() {},
    };
    const mode = createJscpdSessionModeService();
    const config: JscpdConfigService = {
      loadEffect: () => Effect.sync(() => config.current()),
      current: () => ({
        config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
        sources: ["defaults"],
        diagnostics: [],
        trusted: true,
      }),
    };
    const layers = Layer.merge(
      createJscpdStatusWorkflowLayer(nativeCapability, config, mode),
      process.layer,
    );
    const program = Effect.flatMap(JscpdStatusWorkflow, (status) =>
      status.inspect({ cwd: project }),
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result.capability).toMatchObject({ status: "available", version: "5.1.2" });
    expect(process.requests).toHaveLength(1);
  });

  it("does not let a superseded command overwrite restored status", async () => {
    const mode = createJscpdSessionModeService();
    const statusConfig: JscpdConfigService = {
      loadEffect: () => Effect.sync(() => statusConfig.current()),
      current: () => ({
        config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
        sources: ["defaults"],
        diagnostics: [],
        trusted: true,
      }),
    };
    const status = createJscpdStatusService(capability(), statusConfig, mode);
    const program = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const executor = createJscpdStatusAwareExecutor(
        {
          execute: async () => ({
            status: "failed",
            reason: "scan-timed-out",
            message: "timed out",
          }),
          executeEffect: () =>
            Deferred.await(gate).pipe(
              Effect.as({
                status: "failed" as const,
                reason: "scan-timed-out" as const,
                message: "timed out",
              }),
            ),
        },
        status,
        mode,
      );
      const pending = yield* Effect.fork(
        executor.executeEffect?.({ command: "scan", args: [] }, { cwd: project }) ?? Effect.never,
      );
      yield* Effect.yieldNow();
      status.restore({ state: "clean" });
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(pending);
      return { result, lastCheck: status.lastCheck() };
    });

    const result = await JscpdTestEffectRuntime.runPromise(program);

    expect(result.result).toMatchObject({ status: "failed", reason: "scan-timed-out" });
    expect(result.lastCheck).toEqual({ state: "clean" });
  });

  it("evaluates and resets Fallow policy through one Effect owner", async () => {
    const filesystem = createJscpdFileSystemTestLayer([{ path: project, kind: "directory" }]);
    const program = Effect.gen(function* () {
      const fallow = yield* JscpdFallowWorkflow;
      const evaluated = yield* fallow.evaluate({
        cwd: project,
        trusted: true,
        policy: "on-demand",
        fallowToolAvailable: true,
      });
      yield* fallow.reset;
      return { evaluated, current: yield* fallow.current };
    });
    const layers = Layer.merge(createJscpdFallowCoexistenceLayer(), filesystem.layer);

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    expect(result.evaluated).toMatchObject({
      status: "explicit-on-demand",
      automaticAllowed: false,
    });
    expect(result.current).toMatchObject({ status: "absent", automaticAllowed: true });
  });

  it("rejects a Fallow evaluation that completes after its lifecycle reset", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const missing = (operation: JscpdFileSystemFailure["operation"]) =>
        new JscpdFileSystemFailure({ operation, reason: "missing" });
      const filesystem: JscpdFileSystem = {
        canonicalize: (path) =>
          path === project
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Deferred.await(gate)),
                Effect.as(project),
              )
            : Effect.fail(missing("canonicalize")),
        metadata: (path) =>
          path === project
            ? Effect.succeed({ kind: "directory" as const, size: 0 })
            : Effect.fail(missing("metadata")),
        read: () => Effect.fail(missing("read")),
        write: () => Effect.void,
        makeTempDirectory: () => Effect.die("not used"),
        remove: () => Effect.void,
      };
      const layers = Layer.merge(
        createJscpdFallowCoexistenceLayer(),
        Layer.succeed(JscpdFileSystemTag, filesystem),
      );
      return yield* Effect.gen(function* () {
        const fallow = yield* JscpdFallowWorkflow;
        const pending = yield* Effect.fork(
          fallow.evaluate({
            cwd: project,
            trusted: true,
            fallowToolAvailable: true,
          }),
        );
        yield* Deferred.await(entered);
        yield* fallow.reset;
        yield* Deferred.succeed(gate, undefined);
        const evaluated = yield* Fiber.join(pending);
        return { evaluated, current: yield* fallow.current };
      }).pipe(Effect.provide(layers));
    });

    const result = await Effect.runPromise(program);

    expect(result.evaluated).toMatchObject({ status: "absent", automaticAllowed: true });
    expect(result.current).toMatchObject({ status: "absent", automaticAllowed: true });
  });

  it("uses executeEffect without invoking a compatibility Promise executor", async () => {
    const execute = vi.fn(async () => {
      throw new Error("compatibility path must not run");
    });
    const executeEffect = vi.fn(() =>
      Effect.succeed({
        status: "help" as const,
        message: "effect",
        terminalMessage: "effect",
      }),
    );
    const mode = createJscpdSessionModeService();
    const statusConfig: JscpdConfigService = {
      loadEffect: () => Effect.sync(() => statusConfig.current()),
      current: () => ({
        config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
        sources: ["defaults"],
        diagnostics: [],
        trusted: true,
      }),
    };
    const status = createJscpdStatusService(capability(), statusConfig, mode);
    const executor = createJscpdStatusAwareExecutor({ execute, executeEffect }, status, mode);

    const result = await JscpdTestEffectRuntime.runPromise(
      executor.executeEffect?.({ command: "scan", args: [] }, { cwd: project }) ?? Effect.never,
    );

    expect(result).toMatchObject({ status: "help", message: "effect" });
    expect(execute).not.toHaveBeenCalled();
    expect(executeEffect).toHaveBeenCalledOnce();
  });
});
