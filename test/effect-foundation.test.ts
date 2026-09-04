import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  JSCPD_EXPECTED_ERROR_MESSAGE_MAX_LENGTH,
  JSCPD_EXPECTED_ERROR_TAGS,
  JscpdAnalyzerUnavailable,
  JscpdDeliveryFailure,
  JscpdFileSystemFailure,
  JscpdInvalidInput,
  JscpdLimitExceeded,
  JscpdOperationCancelled,
  JscpdOperationTimedOut,
  JscpdPersistenceFailure,
  JscpdProcessFailure,
  JscpdStaleOperation,
  JscpdWorkspaceFailure,
  mapJscpdExpectedError,
} from "../src/effect/errors.js";
import { JscpdClock, JscpdFileSystem, JscpdPiPort, JscpdProcess } from "../src/effect/services.js";
import {
  createJscpdClockTestLayer,
  createJscpdFileSystemTestLayer,
  createJscpdPiPortTestLayer,
  createJscpdProcessTestLayer,
} from "./support/effect-layers.js";

describe("Effect migration foundation", () => {
  it("provides deterministic process, filesystem, clock, and Pi layers", async () => {
    const process = createJscpdProcessTestLayer([
      {
        status: "success",
        result: {
          exitCode: 0,
          stdout: new TextEncoder().encode("jscpd 5.1.2"),
          stderr: new Uint8Array(),
        },
      },
    ]);
    const filesystem = createJscpdFileSystemTestLayer([
      { path: "/project/report.json", bytes: new TextEncoder().encode("{}") },
    ]);
    const clock = createJscpdClockTestLayer(1_000);
    const pi = createJscpdPiPortTestLayer();
    const layers = Layer.mergeAll(process.layer, filesystem.layer, clock.layer, pi.layer);
    const program = Effect.gen(function* () {
      const processService = yield* JscpdProcess;
      const fileSystemService = yield* JscpdFileSystem;
      const clockService = yield* JscpdClock;
      const piService = yield* JscpdPiPort;
      const result = yield* processService.run({
        executable: "jscpd",
        args: ["--version"],
        cwd: "/project",
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      });
      const report = yield* fileSystemService.read({
        path: "/project/report.json",
        maxBytes: 16,
        regularFileOnly: true,
        noFollow: true,
      });
      yield* clockService.sleep(25);
      const now = yield* clockService.now;
      yield* piService.appendSessionEntry("pi-jscpd/session-state", { version: 3 });
      yield* piService.sendMessage(
        {
          customType: "pi-jscpd/automatic-findings",
          content: "bounded finding",
          display: false,
        },
        false,
      );
      return { result, report, now };
    });

    const result = await Effect.runPromise(Effect.provide(program, layers));

    expect(new TextDecoder().decode(result.result.stdout)).toBe("jscpd 5.1.2");
    expect(new TextDecoder().decode(result.report)).toBe("{}");
    expect(result.now).toBe(1_025);
    expect(process.requests).toEqual([
      expect.objectContaining({ executable: "jscpd", args: ["--version"] }),
    ]);
    expect(filesystem.operations).toEqual(["read:/project/report.json"]);
    expect(clock.sleeps).toEqual([25]);
    expect(pi.sessionEntries).toEqual([
      { customType: "pi-jscpd/session-state", data: { version: 3 } },
    ]);
    expect(pi.messages).toEqual([
      {
        message: {
          customType: "pi-jscpd/automatic-findings",
          content: "bounded finding",
          display: false,
        },
        triggerTurn: false,
      },
    ]);
  });

  it("makes deterministic failures available through typed channels", async () => {
    const process = createJscpdProcessTestLayer([
      { status: "failure", error: new JscpdOperationCancelled({ stage: "scan" }) },
    ]);
    const program = Effect.flatMap(JscpdProcess, (service) =>
      service.run({
        executable: "jscpd",
        args: [],
        cwd: "/project",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    );

    const exit = await Effect.runPromiseExit(Effect.provide(program, process.layer));

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("JscpdOperationCancelled");
  });

  it("keeps stable expected-error tags and bounded fail-open public mappings", () => {
    const errors = [
      new JscpdAnalyzerUnavailable({ reason: "missing" }),
      new JscpdProcessFailure({ stage: "scan", reason: "spawn" }),
      new JscpdFileSystemFailure({ operation: "read", reason: "missing" }),
      new JscpdOperationCancelled({ stage: "scan" }),
      new JscpdOperationTimedOut({ stage: "baseline" }),
      new JscpdLimitExceeded({ subject: "report" }),
      new JscpdInvalidInput({ subject: "path", reason: "unsafe" }),
      new JscpdStaleOperation({ operation: "automatic" }),
      new JscpdWorkspaceFailure({ operation: "cleanup" }),
      new JscpdPersistenceFailure({ operation: "append" }),
      new JscpdDeliveryFailure({ channel: "message" }),
    ];

    expect(JSCPD_EXPECTED_ERROR_TAGS).toEqual([
      "JscpdAnalyzerUnavailable",
      "JscpdProcessFailure",
      "JscpdFileSystemFailure",
      "JscpdOperationCancelled",
      "JscpdOperationTimedOut",
      "JscpdLimitExceeded",
      "JscpdInvalidInput",
      "JscpdStaleOperation",
      "JscpdWorkspaceFailure",
      "JscpdPersistenceFailure",
      "JscpdDeliveryFailure",
    ]);
    const mappings = errors.map(mapJscpdExpectedError);
    expect(mappings).toEqual([
      expect.objectContaining({ disposition: "result", reason: "missing-binary" }),
      expect.objectContaining({ disposition: "result", reason: "process-failed" }),
      expect.objectContaining({ disposition: "result", reason: "missing-report" }),
      expect.objectContaining({ disposition: "result", reason: "scan-cancelled" }),
      expect.objectContaining({ disposition: "result", reason: "baseline-timed-out" }),
      expect.objectContaining({ disposition: "result", reason: "invalid-report" }),
      expect.objectContaining({ disposition: "result", reason: "unsafe-path" }),
      expect.objectContaining({ disposition: "defer", reason: "stale-operation" }),
      expect.objectContaining({ disposition: "result", reason: "cleanup-failed" }),
      expect.objectContaining({ disposition: "ignore", reason: "persistence-failed" }),
      expect.objectContaining({ disposition: "defer", reason: "delivery-failed" }),
    ]);
    expect(
      mapJscpdExpectedError(new JscpdProcessFailure({ stage: "probe", reason: "spawn" })),
    ).toMatchObject({ disposition: "result", status: "unavailable", reason: "probe-failed" });
    for (const mapping of mappings) {
      expect(Array.from(mapping.message).length).toBeLessThanOrEqual(
        JSCPD_EXPECTED_ERROR_MESSAGE_MAX_LENGTH,
      );
      expect(mapping.message).not.toMatch(/stack|environment|stderr|stdout/i);
    }
  });
});
