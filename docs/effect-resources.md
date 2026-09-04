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

`src/jscpd.ts` now uses an Effect semaphore instead of the Promise job queue.
`JscpdAdapter` and `createJscpdLayer` expose the Effect-native scoped service.
Each run acquires its restrictive out-of-project report workspace, executes one
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
`JscpdProcess` directly; injected compatibility executors remain a bounded test
and adapter seam.

## Temporary application bridge

Application workflows now expose native effects, while the Pi/TUI host adapters
still use temporary Promise facades. `src/effect/runtime-boundary.ts` is the only
temporary production `Effect.run*` location. It does not create a private managed
runtime; it executes short-lived effects on Effect's default runtime and bridges
the existing Promise surface. The architecture checker allowlists this file and
`src/extension.ts` only.

M7.7 removes the temporary bridge and routes these same effects through the one
managed runtime/root scope owned by the extension instance. Lower process,
analyzer, and capability modules never call `Effect.run*` themselves.

## Verification contract

Tests retain every prior analyzer outcome and add direct Effect-layer coverage.
They verify typed output-limit failures, fiber interruption, graceful-then-forced
process-tree cleanup, scoped report cleanup, serialization, invalidation,
disposal, caching, fallback order, bounded reports, and absence of source or
child-output leakage. Packed-artifact shutdown certification continues to stop Pi
during a real active analyzer process and assert process/report cleanup.
