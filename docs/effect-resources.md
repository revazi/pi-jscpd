# Effect-owned process and analyzer resources

Status: **implemented for M7.2; release-blocking migration continues**

Issue [#65](https://github.com/revazi/pi-jscpd/issues/65) moves the lowest-level
runtime ownership into Effect without changing the public `jscpd_run`, `/jscpd`,
or result contracts.

## Owned resources

`src/process.ts` provides the live `JscpdProcess` layer. Each shell-free child is
acquired for one effect and finalized for success, typed failure, timeout,
output-limit failure, or fiber interruption. Finalization sends `SIGTERM`, waits
the configured bounded grace period, escalates to `SIGKILL`, checks remaining
Unix process-group descendants, detaches listeners, destroys abandoned streams,
and never exposes child output.

Process timeout races use the Effect clock. Combined stdout/stderr capture remains
bounded. Missing executables, spawn failures, timeout, output limits, invalid
requests, and interruption remain distinguishable before the existing public
facade maps them to its stable result union.

`src/jscpd.ts` uses an Effect semaphore instead of the former Promise job queue.
`JscpdService`, `JscpdAdapter`, and `createJscpdLayer` expose only Effect-native
run and disposal operations; the temporary lower-service Promise facade and
parallel report-consumer callback have been removed. Each run acquires its
restrictive out-of-project report workspace, executes one
serialized analyzer process, consumes a bounded regular non-symlink report
through the injected filesystem service, and releases the workspace. The adapter
layer leaves process and filesystem requirements visible to its caller. Cleanup
is itself time-bounded, and failure or timeout
still overrides a scan result with `cleanup-failed`. Invalidation and disposal
interrupt active or queued effects; disposal waits for the semaphore after
finalizers settle.

`src/capability.ts` exposes `JscpdCapability` and a scoped layer. Route probing,
fallback order, interruption, active-probe ownership, generation-aware caching,
and disposal are composed as effects. The production executor calls
`JscpdProcess` directly. Both the capability service and executor now require
native effects; Promise executors exist only as characterization fixtures under
`test/support/`. Native defects map to bounded non-cacheable failures, while
fiber interruption remains distinct and waits for finalizers.

## Managed host boundary

Application workflows expose native effects. Pi host adapters accept the
extension-owned `JscpdEffectRuntime`; `src/effect/runtime-boundary.ts` is the only
production module that calls `Effect.run*` or creates a `ManagedRuntime`. Lower
process, analyzer, and capability modules never execute Effect directly.

Pi tools, commands, lifecycle handlers, automatic fibers, and overlay actions
route through this runtime. Shutdown awaits tracked quiet baseline work, then
closes scheduler and analyzer resources before disposing its root layer scope.
Isolated tests execute effects through `test/support/runtime.ts`;
characterization Promise fakes are adapted only under `test/support/`.

## Verification contract

Tests retain every prior analyzer outcome and add direct Effect-layer coverage.
They verify typed output-limit failures, fiber interruption, graceful-then-forced
process-tree cleanup, scoped report cleanup, serialization, invalidation,
disposal, caching, fallback order, bounded reports, and absence of source or
child-output leakage. Packed-artifact shutdown certification continues to stop Pi
during a real active analyzer process and assert process/report cleanup.
