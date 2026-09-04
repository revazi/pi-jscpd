import { Effect } from "effect";
import {
  createJscpdCapabilityLayer,
  createJscpdCapabilityService,
  createNodeProbeExecutor,
  type JscpdCapabilityRequest,
  type JscpdCapabilityResult,
  type JscpdCapabilityService,
  type JscpdProbeExecutionRequest,
  type JscpdProbeExecutionResult,
  type JscpdProbeExecutor,
} from "../../src/capability.js";
import { JscpdTestEffectRuntime } from "../../src/effect/runtime-boundary.js";

export type TestCapabilityProbe = (
  request: JscpdCapabilityRequest,
) => Promise<JscpdCapabilityResult>;
export interface TestProbeExecutor {
  run(request: JscpdProbeExecutionRequest): Promise<JscpdProbeExecutionResult>;
}

/** Promise fixtures remain test-only; all production probe ports are native effects. */
function probeExecutorFromPromise(executor: TestProbeExecutor): JscpdProbeExecutor {
  return {
    runEffect: (request) =>
      Effect.tryPromise({
        try: (signal) =>
          executor.run({ ...request, signal: AbortSignal.any([request.signal, signal]) }),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.succeed({ status: "failed" } as const))),
  };
}

export function capabilityFromPromise(probe: TestCapabilityProbe): JscpdCapabilityService {
  return {
    probeEffect: (request) =>
      Effect.tryPromise({ try: () => probe(request), catch: () => undefined }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            status: "failed",
            executable: "jscpd",
            reason: "execution-error",
          } as const),
        ),
      ),
    invalidate() {},
    dispose() {},
  };
}

export function createCapabilityTestDriver(executor?: TestProbeExecutor) {
  const service = createJscpdCapabilityService(executor && probeExecutorFromPromise(executor));
  return {
    probeEffect: (request: JscpdCapabilityRequest) => service.probeEffect(request),
    probe: (request: JscpdCapabilityRequest) =>
      JscpdTestEffectRuntime.runPromise(service.probeEffect(request)),
    invalidate: () => service.invalidate(),
    dispose: () => service.dispose(),
  };
}

export function createCapabilityTestLayer(executor: TestProbeExecutor) {
  return createJscpdCapabilityLayer(probeExecutorFromPromise(executor));
}

export function createNodeProbeTestDriver() {
  const executor = createNodeProbeExecutor();
  return {
    run: (request: JscpdProbeExecutionRequest) =>
      JscpdTestEffectRuntime.runPromise(executor.runEffect(request)),
  };
}
