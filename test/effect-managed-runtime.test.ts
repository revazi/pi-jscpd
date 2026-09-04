import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { dispatchJscpdCommand } from "../src/dispatch.js";
import type { JscpdEffectRuntime } from "../src/effect/runtime-boundary.js";
import { registerJscpdExtension } from "../src/extension.js";
import type { JscpdCommandExecutor } from "../src/types.js";
import { JscpdTestEffectRuntime } from "./support/runtime.js";

function trackedRuntime() {
  const calls = { promise: 0, exit: 0, sync: 0, dispose: 0 };
  const runtime: JscpdEffectRuntime = {
    runPromise(effect, signal) {
      calls.promise += 1;
      return JscpdTestEffectRuntime.runPromise(effect, signal);
    },
    runPromiseExit(effect, signal) {
      calls.exit += 1;
      return JscpdTestEffectRuntime.runPromiseExit(effect, signal);
    },
    runSync(effect) {
      calls.sync += 1;
      return JscpdTestEffectRuntime.runSync(effect);
    },
    async dispose() {
      calls.dispose += 1;
    },
  };
  return { runtime, calls };
}

describe("managed extension runtime boundary", () => {
  it("fails open when a native executor throws while constructing its program", async () => {
    await expect(
      dispatchJscpdCommand(
        "scan",
        [],
        { cwd: "/project" },
        {
          executeEffect: () => {
            throw new Error("sensitive construction failure");
          },
        },
        JscpdTestEffectRuntime,
      ),
    ).resolves.toEqual({
      status: "error",
      reason: "execution-failed",
      message: "The jscpd request failed without interrupting the Pi session.",
    });
  });

  it("runs a tool effect once, interrupts it from Pi cancellation, and disposes once", async () => {
    const tracked = trackedRuntime();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let tool: ToolDefinition | undefined;
    let enteredResolve: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let interrupted = false;
    const executor: JscpdCommandExecutor = {
      executeEffect: () =>
        Effect.async<never>(() => {
          enteredResolve();
          return Effect.sync(() => {
            interrupted = true;
          });
        }),
    };
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tool = definition;
      }),
      registerCommand: vi.fn(),
      getAllTools: () => [],
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;

    registerJscpdExtension(pi, { executor, runtime: tracked.runtime });
    const beforeToolRuns = tracked.calls.promise + tracked.calls.exit;
    const controller = new AbortController();
    const pending = tool?.execute(
      "runtime-test",
      { command: "scan", args: [] },
      controller.signal,
      undefined,
      { cwd: "/project", signal: controller.signal } as ExtensionContext,
    );
    await entered;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      details: { status: "failed", reason: "scan-cancelled" },
    });
    expect(interrupted).toBe(true);
    expect(tracked.calls.promise + tracked.calls.exit - beforeToolRuns).toBe(1);

    await handlers.get("session_shutdown")?.();
    await handlers.get("session_shutdown")?.();
    expect(tracked.calls.dispose).toBe(1);
  });
});
