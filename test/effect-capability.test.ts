import { Cause, Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
  createJscpdCapabilityService,
  createNodeProbeExecutor,
  type JscpdProbeExecutionRequest,
} from "../src/capability.js";
import { createJscpdProcessTestLayer } from "./support/effect-layers.js";

const request = { cwd: "/project", path: "/test/bin" };
const processResult = {
  exitCode: 0,
  stdout: new TextEncoder().encode("5.1.2\n"),
  stderr: new Uint8Array(),
};

function probeRequest(signal: AbortSignal): JscpdProbeExecutionRequest {
  return {
    ...request,
    signal,
    executable: "jscpd",
    args: ["--version"],
    timeoutMs: 100,
    maxOutputBytes: 4096,
  };
}

describe("Effect-only capability boundary", () => {
  it("is lazy, caches stable results, and executes only the injected process", async () => {
    const processes = createJscpdProcessTestLayer([{ status: "success", result: processResult }]);
    const service = createJscpdCapabilityService();
    const probe = service.probeEffect(request);
    expect(processes.requests).toEqual([]);
    const results = await Effect.runPromise(
      Effect.all([probe, probe], { concurrency: 1 }).pipe(Effect.provide(processes.layer)),
    );
    expect(results[0]).toMatchObject({ status: "available", version: "5.1.2" });
    expect(results[1]).toBe(results[0]);
    expect(processes.requests).toHaveLength(1);
  });

  it("contains a native executor defect without exposing or caching private details", async () => {
    let calls = 0;
    const service = createJscpdCapabilityService({
      runEffect: () =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.die("private diagnostic");
        }),
    });
    const processes = createJscpdProcessTestLayer([]);
    const results = await Effect.runPromise(
      Effect.all([service.probeEffect(request), service.probeEffect(request)]).pipe(
        Effect.provide(processes.layer),
      ),
    );
    expect(results).toEqual(
      Array(2).fill({ status: "failed", executable: "jscpd", reason: "execution-error" }),
    );
    expect(calls).toBe(2);
    expect(processes.requests).toEqual([]);
  });

  it("preserves fiber interruption and waits for executor finalizers", async () => {
    let finalized = false;
    const processes = createJscpdProcessTestLayer([]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const service = createJscpdCapabilityService({
          runEffect: () =>
            Effect.acquireUseRelease(
              Effect.void,
              () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
              () =>
                Effect.sync(() => {
                  finalized = true;
                }),
            ),
        });
        const fiber = yield* Effect.fork(service.probeEffect(request));
        yield* Deferred.await(entered);
        const exit = yield* Fiber.interrupt(fiber);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
        expect(finalized).toBe(true);
        service.dispose();
      }).pipe(Effect.provide(processes.layer)),
    );
  });

  it("does not start the native process executor with an already-aborted signal", async () => {
    const processes = createJscpdProcessTestLayer([]);
    const controller = new AbortController();
    controller.abort();
    const result = await Effect.runPromise(
      createNodeProbeExecutor()
        .runEffect(probeRequest(controller.signal))
        .pipe(Effect.provide(processes.layer)),
    );
    expect(result).toEqual({ status: "cancelled" });
    expect(processes.requests).toEqual([]);
  });
});
