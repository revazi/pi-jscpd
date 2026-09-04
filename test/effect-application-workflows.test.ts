import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import type { JscpdBaselineService } from "../src/baseline.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import { createJscpdChangedWorkflowLayer, JscpdChangedWorkflow } from "../src/changed.js";
import type { JscpdChangedFileTracker } from "../src/changed-files.js";
import type { JscpdConfigService } from "../src/config.js";
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
    async run() {
      return { status: "no-findings", value: cleanReport };
    },
    invalidate() {},
    async dispose() {},
  } as JscpdService;
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

  it("prefers native capability and adapter effects over compatibility promises", async () => {
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
      async run() {
        throw new Error("compatibility adapter must not run");
      },
      runEffect: (() =>
        Effect.succeed({ status: "no-findings" as const, value: cleanReport })) as NonNullable<
        JscpdService["runEffect"]
      >,
      invalidate() {},
      async dispose() {},
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
      async start() {
        return this.current();
      },
      async wait() {
        throw new Error("compatibility baseline wait must not run");
      },
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
      async start() {},
      reset() {},
      async recordToolResult() {
        return false;
      },
      async recordToolResultPath() {
        return undefined;
      },
      files: () => ["src/a.ts"],
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

  it("keeps status inspection and recording in one Effect-owned state service", async () => {
    const config: JscpdConfigService = {
      async load() {
        return this.current();
      },
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
    const layers = Layer.merge(
      createJscpdStatusWorkflowLayer(capability(), config, mode),
      createJscpdSessionModeLayer(mode),
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
      load: async () => statusConfig.current(),
      current: () => ({
        config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
        sources: ["defaults"],
        diagnostics: [],
        trusted: true,
      }),
    };
    const status = createJscpdStatusService(capability(), statusConfig, mode);
    const executor = createJscpdStatusAwareExecutor({ execute, executeEffect }, status, mode);

    const result = await Effect.runPromise(
      executor.executeEffect?.({ command: "scan", args: [] }, { cwd: project }) ?? Effect.never,
    );

    expect(result).toMatchObject({ status: "help", message: "effect" });
    expect(execute).not.toHaveBeenCalled();
    expect(executeEffect).toHaveBeenCalledOnce();
  });
});
