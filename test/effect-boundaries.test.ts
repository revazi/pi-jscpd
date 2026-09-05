import { describe, expect, it } from "vitest";

const {
  APPROVED_EFFECT_RUNTIME_BOUNDARIES,
  APPROVED_PROMISE_WORKFLOW_BOUNDARIES,
  EFFECT_ONLY_SERVICE_BOUNDARIES,
  findServiceExecutionBridges,
  MIGRATED_APPLICATION_BOUNDARIES,
  MIGRATED_CONCURRENCY_BOUNDARIES,
  MIGRATED_FILESYSTEM_BOUNDARIES,
  findEffectRuntimeCalls,
  findManagedRuntimeCreations,
  findNodeFileSystemImports,
  findPromiseWorkflowConstructs,
  findUnmanagedAsyncConstructs,
} = await import(
  // @ts-expect-error The executable architecture script intentionally has no published type surface.
  "../scripts/check-effect-boundaries.mjs"
);

describe("Effect runtime architecture boundary", () => {
  it("rejects runtime dependencies and Promise contracts in Effect-only services", () => {
    const source = `
      import { runner as testRunner } from "./effect/runtime-boundary.js";
      import type { JscpdEffectRuntime } from "./effect/runtime-contract.js";
      const load = (): Promise<void> => testRunner["runPromise"](program);
      const dynamic = import("./effect/runtime-boundary.js");
      // testRunner.runSync(program)
      const text = "./effect/runtime-boundary.js";
    `;
    expect(findServiceExecutionBridges(source).map(({ name }: { name: string }) => name)).toEqual([
      "runtime dependency",
      "runtime dependency",
      "Promise contract",
      "execution bridge: runPromise",
      "runtime dependency",
    ]);
    expect(EFFECT_ONLY_SERVICE_BOUNDARIES).toContain("src/changed-files.ts");
    expect(
      findServiceExecutionBridges(
        `import { Effect } from "effect"; const load = () => Effect.void;`,
      ),
    ).toEqual([]);
  });
  it("recognizes aliases, namespace and element access, and direct named runners", () => {
    const source = `
      import { Effect as Fx } from "effect";
      import * as EffectModule from "effect/Effect";
      import { runPromise as execute } from "effect/Effect";
      import * as EffectPackage from "effect";
      const Alias = Fx;
      const named = Fx.runSync;
      const { runPromiseExit: exit } = Fx;
      Fx.runPromise(program);
      Alias["runFork"](program);
      EffectModule.runSync(program);
      EffectPackage.Effect.runCallback(program);
      execute(program);
      named(program);
      exit(program);
    `;

    expect(
      findEffectRuntimeCalls(source, "src/fixture.ts").map(({ name }: { name: string }) => name),
    ).toEqual([
      "runPromise",
      "runFork",
      "runSync",
      "runCallback",
      "runPromise",
      "runSync",
      "runPromiseExit",
    ]);
  });

  it("recognizes Effect destructured from an effect package namespace", () => {
    const source = `
      import * as EffectPackage from "effect";
      const { Effect: DirectFx } = EffectPackage;
      const PackageAlias = EffectPackage;
      const { Effect: AliasedFx } = PackageAlias;
      DirectFx.runPromise(program);
      AliasedFx.runSync(program);
    `;

    expect(findEffectRuntimeCalls(source, "src/fixture.ts")).toMatchObject([
      { path: "src/fixture.ts", line: 6, name: "runPromise" },
      { path: "src/fixture.ts", line: 7, name: "runSync" },
    ]);
  });

  it("ignores comments, strings, unrelated objects, and type-only references", () => {
    const source = `
      import { Effect } from "effect";
      import type { Effect as EffectType } from "effect";
      // Effect.runPromise(program)
      const text = "Effect.runSync(program)";
      const unrelated = { runPromise() {} };
      unrelated.runPromise();
      type Runner = typeof Effect.runPromise;
      EffectType.runSync(program);
    `;

    expect(findEffectRuntimeCalls(source)).toEqual([]);
  });

  it("respects lexical bindings that shadow imported Effect runners", () => {
    const source = `
      import { Effect } from "effect";
      import { runPromise as execute } from "effect/Effect";
      function useLocal() {
        const Effect = localEffect;
        const execute = localRunner;
        Effect.runSync(program);
        execute(program);
      }
      Effect.runPromise(program);
      execute(program);
    `;

    expect(findEffectRuntimeCalls(source, "src/fixture.ts")).toMatchObject([
      { line: 10, name: "runPromise" },
      { line: 11, name: "runPromise" },
    ]);
  });

  it("detects direct Node filesystem imports in migrated modules", () => {
    const source = `
      import { readFile } from "node:fs/promises";
      import type { Stats } from "node:fs";
      import { join } from "node:path";
    `;

    expect(findNodeFileSystemImports(source, "src/config.ts")).toEqual([
      { path: "src/config.ts", line: 2, moduleName: "node:fs/promises" },
      { path: "src/config.ts", line: 3, moduleName: "node:fs" },
    ]);
    expect(MIGRATED_FILESYSTEM_BOUNDARIES).toContain("src/jscpd-report.ts");
  });

  it("detects unmanaged Promise and timer creation in migrated concurrency modules", () => {
    const source = `
      const deferred = new Promise((resolve) => resolve());
      queueMicrotask(start);
      setTimeout(retry, 10);
      Effect.sleep(10);
    `;

    expect(findUnmanagedAsyncConstructs(source, "src/scheduler.ts")).toEqual([
      { path: "src/scheduler.ts", line: 2, name: "new Promise" },
      { path: "src/scheduler.ts", line: 3, name: "queueMicrotask" },
      { path: "src/scheduler.ts", line: 4, name: "setTimeout" },
    ]);
    expect(MIGRATED_CONCURRENCY_BOUNDARIES).toEqual(["src/automatic.ts", "src/scheduler.ts"]);
  });

  it("detects managed runtime construction without matching comments or strings", () => {
    const source = `
      import { ManagedRuntime } from "effect";
      const runtime = ManagedRuntime.make(Live);
      const text = "ManagedRuntime.make(Fake)";
      // ManagedRuntime.make(Commented)
    `;

    expect(findManagedRuntimeCreations(source, "src/effect/runtime-boundary.ts")).toEqual([
      {
        path: "src/effect/runtime-boundary.ts",
        line: 3,
        name: "ManagedRuntime.make",
      },
    ]);
  });

  it("detects async and Promise-chain orchestration in migrated application modules", () => {
    const source = `
      async function workflow() { return await operation(); }
      const created = new Promise(resolve => resolve());
      const grouped = Promise.all(workflows);
      const chained = operation().then(onSuccess).catch(onFailure).finally(cleanup);
      const effect = Effect.flatMap(operation, onSuccess);
    `;

    expect(findPromiseWorkflowConstructs(source, "src/scan.ts")).toEqual([
      { path: "src/scan.ts", line: 2, name: "async function" },
      { path: "src/scan.ts", line: 3, name: "new Promise" },
      { path: "src/scan.ts", line: 4, name: "Promise.all" },
      { path: "src/scan.ts", line: 5, name: "Promise.finally" },
      { path: "src/scan.ts", line: 5, name: "Promise.catch" },
      { path: "src/scan.ts", line: 5, name: "Promise.then" },
    ]);
    expect(MIGRATED_APPLICATION_BOUNDARIES).toEqual([
      "src/baseline.ts",
      "src/changed.ts",
      "src/fallow.ts",
      "src/scan.ts",
      "src/status.ts",
      "src/verification.ts",
    ]);
  });

  it("guards migrated native services against returning Promise facades", () => {
    expect(EFFECT_ONLY_SERVICE_BOUNDARIES).toEqual(
      expect.arrayContaining(["src/scheduler.ts", "src/automatic.ts", "src/jscpd.ts"]),
    );
  });

  it("confines Promise orchestration to reviewed host and filesystem boundaries", () => {
    expect(APPROVED_PROMISE_WORKFLOW_BOUNDARIES).toEqual([
      "src/effect/filesystem.ts",
      "src/extension.ts",
      "src/overlay.ts",
    ]);
  });

  it("keeps production runtime execution in the explicit managed adapter", () => {
    expect(APPROVED_EFFECT_RUNTIME_BOUNDARIES).toEqual(["src/effect/runtime-boundary.ts"]);
  });
});
