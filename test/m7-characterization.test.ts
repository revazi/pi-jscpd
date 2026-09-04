import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { registerJscpdExtension } from "../src/extension.js";
import { boundedJscpdDisplayPath } from "../src/finding-presentation.js";
import { presentJscpdChanged } from "../src/presentation.js";
import { jscpdCommandNames } from "../src/registry.js";
import {
  JSCPD_SESSION_STATE_TYPE,
  JSCPD_SESSION_STATE_VERSION,
  restoreJscpdSessionState,
} from "../src/session-state.js";
import type { JscpdScanReport } from "../src/types.js";
import { commandFromPromise, type TestCommandExecute } from "./support/command.js";
import { createTestToolDefinition as createJscpdToolDefinition } from "./support/host.js";
import { createSchedulerTestDriver as createJscpdScanScheduler } from "./support/scheduler.js";

const cancelled = {
  status: "failed",
  reason: "scan-cancelled",
  message: "The jscpd scan was cancelled and its temporary report was removed.",
} as const;

describe("M7.1 observable behavior characterization", () => {
  it("keeps the public command and tool cancellation contract unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn<TestCommandExecute>(async () => cancelled);
    const tool = createJscpdToolDefinition(commandFromPromise(execute));

    const result = await tool.execute(
      "characterization",
      { command: "scan", args: ["src"] },
      controller.signal,
      undefined,
      { cwd: "/project" } as ExtensionContext,
    );

    expect(jscpdCommandNames).toEqual(["scan", "changed", "status", "off", "on", "help"]);
    expect(tool).toMatchObject({ name: "jscpd_run", label: "jscpd" });
    expect(execute).toHaveBeenCalledWith(
      { command: "scan", args: ["src"] },
      { cwd: "/project", signal: controller.signal },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: cancelled.message }],
      details: cancelled,
    });
  });

  it("keeps lifecycle invalidation and shutdown idempotent", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const adapterDispose = vi.fn(async () => undefined);
    const adapter = {
      invalidate: vi.fn(),
      dispose: adapterDispose,
      disposeEffect: () => Effect.promise(adapterDispose),
    };
    const scheduler = createJscpdScanScheduler();
    const cancelAutomatic = vi.spyOn(scheduler, "cancelAutomatic");
    const dispose = vi.spyOn(scheduler, "dispose");
    const configResult = {
      config: {
        enabled: true,
        timeoutMs: 30_000,
        maxFindings: 10,
        fallowCoexistence: "auto" as const,
      },
      sources: ["defaults" as const],
      diagnostics: [],
      trusted: true,
    };
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      getAllTools: () => [],
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(event, handler),
      ),
    } as unknown as ExtensionAPI;

    registerJscpdExtension(pi, {
      executor: commandFromPromise(async () => cancelled),
      adapterService: adapter as never,
      configService: {
        loadEffect: () => Effect.succeed(configResult),
        current: () => configResult,
      },
      scheduler,
    });
    const context = {
      cwd: "/project",
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
    };

    await handlers.get("session_start")?.({}, context);
    await handlers.get("before_agent_start")?.({}, context);
    await handlers.get("session_before_switch")?.();
    await handlers.get("session_shutdown")?.();
    await handlers.get("session_shutdown")?.();

    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_tree",
      "session_before_switch",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(adapter.invalidate).toHaveBeenCalledTimes(2);
    expect(cancelAutomatic).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(adapter.dispose).toHaveBeenCalledOnce();
  });

  it("keeps persisted state branch-local, versioned, and bounded", () => {
    const state = {
      version: JSCPD_SESSION_STATE_VERSION,
      modeOverride: "disabled",
      lastCheck: { state: "cancelled" },
      changedFiles: ["src/a.ts"],
      acknowledgements: { identityVersion: 1, findings: [] },
    } as const;
    const branch = [
      { type: "custom", customType: "another-extension", data: state },
      { type: "custom", customType: JSCPD_SESSION_STATE_TYPE, data: state },
    ];

    expect(restoreJscpdSessionState(branch)).toEqual(state);
    expect(
      restoreJscpdSessionState([
        ...branch,
        {
          type: "custom",
          customType: JSCPD_SESSION_STATE_TYPE,
          data: { ...state, version: 999 },
        },
      ]),
    ).toBeUndefined();
  });

  it("keeps finding counts and user-controlled display paths bounded", () => {
    const longPath = `src/${"segment/".repeat(80)}file.ts`;
    const clonePairs = Array.from({ length: 20 }, (_, index) =>
      clonePair(index, longPath, `src/existing-${index}.ts`),
    );

    const result = presentJscpdChanged(clonePairs, new Set([longPath]));

    expect(result.findings).toHaveLength(10);
    expect(result.omittedFindings).toBe(10);
    expect(Array.from(result.findings[0]?.occurrences[0].path ?? "")).toHaveLength(240);
    expect(result.message).not.toContain(longPath);
    expect(result.message.length).toBeLessThan(10_000);
    expect(Array.from(boundedJscpdDisplayPath(longPath))).toHaveLength(240);
  });
});

function clonePair(
  index: number,
  firstPath: string,
  secondPath: string,
): JscpdScanReport["clonePairs"][number] {
  return {
    format: "typescript",
    lines: 4,
    tokens: 20,
    occurrences: [
      {
        path: firstPath,
        start: { line: index + 1, column: 0, offset: index },
        end: { line: index + 4, column: 1, offset: index + 1 },
      },
      {
        path: secondPath,
        start: { line: index + 10, column: 0, offset: index },
        end: { line: index + 13, column: 1, offset: index + 1 },
      },
    ],
  };
}
