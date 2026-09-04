# Effect foundation contract

Issue [#64](https://github.com/revazi/pi-jscpd/issues/64) establishes the first,
behavior-preserving Effect migration slice. It declares contracts and test support
only. M7.2 builds on these contracts for process and analyzer resources, M7.3
provides the bounded filesystem layer used by configuration and external data
boundaries, M7.4 moves lifecycle-bound domain state to Effect-owned services,
M7.5 moves scheduling and automatic delivery to scoped fibers and Effect
transactions, M7.6 composes the application workflows, and M7.7 routes Pi/TUI
host work through one managed extension runtime. The final legacy-removal and
conformance audit remains.

## Reviewed dependency

The package exact-pins **Effect `3.22.1`** as a normal runtime dependency. At
selection time it was the npm registry's current stable 3.x release; the installed
package metadata identifies the release as MIT licensed and declares no Node engine
range that conflicts with the supported Node 22.19 and 24 lines. The lockfile
records registry integrity
`sha512-TNoXushmPOBAjJlthF5d2QwnX2xBPEtcNJr5XKNKbRLbDvBcOYkXlYDfvGfSA0zriwLFuCll5MDtNMAdZL17PQ==`.
Its runtime dependency closure adds `@standard-schema/spec`, `fast-check`, and
`pure-rand`; no install script or overlapping async/resource framework is added.

This exact pin is a compatibility fixture, not a range. Updating it requires a
focused architecture and compatibility review, lockfile regeneration, both
supported Node checks, and packed-artifact recertification.

## Declarative service boundary

`src/effect/services.ts` defines four `Context` service tags:

- `JscpdProcess`: shell-free bounded execution whose future implementation owns
  process-tree cleanup;
- `JscpdFileSystem`: canonicalization, metadata, bounded reads/writes, temporary
  directory creation, and removal;
- `JscpdClock`: current time and sleep as explicit scheduling dependencies; and
- `JscpdPiPort`: bounded session persistence, finding delivery, notifications,
  and footer status without importing Pi UI types into lower layers.

The interfaces return effects with expected typed failures. M7.2 provides the
live process implementation, M7.3 provides `JscpdFileSystemLive`, and M7.5
provides `JscpdClockLive`; the Pi port remains declarative until its owning
boundary slice. Deterministic layer factories
live only under `test/support/effect-layers.ts`; tests can inspect requests,
files, time, and Pi writes without patching globals. M7.4 adds domain tags beside
their owning modules so pure domain contracts remain local. M7.5 adds scoped
scheduler and automatic-check tags while retaining the same deterministic Pi
port. M7.6 adds scan, changed, status/session-mode, and Fallow application tags.
See the [filesystem and decoding boundary](effect-filesystem.md),
[Effect-owned domain state](effect-domain-state.md),
[Effect-owned scheduling and automatic checks](effect-scheduler-automatic.md),
[Effect-composed application workflows](effect-application-workflows.md), and
the [Managed Effect runtime and Pi boundary](effect-managed-runtime.md).

## Stable expected-error taxonomy

`src/effect/errors.ts` reserves these expected operational tags:

| Tag | Meaning |
| --- | --- |
| `JscpdAnalyzerUnavailable` | Missing or incompatible analyzer route |
| `JscpdProcessFailure` | Probe/scan spawn, exit, or process-tree termination failure |
| `JscpdFileSystemFailure` | Bounded canonicalization, metadata, read, write, or removal failure |
| `JscpdOperationCancelled` | Probe, scan, baseline, or lifecycle cancellation |
| `JscpdOperationTimedOut` | Probe, scan, or baseline timeout |
| `JscpdLimitExceeded` | Process output, report, configuration, path, message, or state bound |
| `JscpdInvalidInput` | Invalid configuration, path, or report |
| `JscpdStaleOperation` | Generation- or lifecycle-superseded result |
| `JscpdWorkspaceFailure` | Temporary workspace creation, report read, or cleanup failure |
| `JscpdPersistenceFailure` | Branch-state restore or append failure |
| `JscpdDeliveryFailure` | Message, notification, or status delivery failure |

Errors carry only bounded enum metadata. Raw exceptions, process output,
environment values, source fragments, and private paths do not belong in these
values.

## Public fail-open mapping

`mapJscpdExpectedError` fixes the intended bounded mapping while later slices
replace each production workflow. It does not participate in production yet.
Context-specific mappings preserve current public results:

| Expected error | Existing public handling |
| --- | --- |
| Analyzer missing/incompatible | `unavailable` with `missing-binary` or `incompatible-version` |
| Probe cancellation/timeout | `unavailable` with `probe-cancelled` or `probe-timed-out` |
| Scan cancellation/timeout | `failed` with `scan-cancelled` or `scan-timed-out` |
| Baseline cancellation/timeout | `changed-unavailable` with `baseline-cancelled` or `baseline-timed-out` |
| Unsafe/unsupported path | `failed` with `unsafe-path` or `unsupported-path` |
| Malformed/incompatible/invalid report | The corresponding bounded `failed` report reason |
| Probe process failure | `unavailable` with `probe-failed` |
| Scan process, workspace, or cleanup failure | `process-failed`, `missing-report`, or `cleanup-failed` as applicable |
| Invalid or oversized configuration | One bounded diagnostic; continue with trusted lower-precedence/default configuration |
| Stale operation or oversized advisory state | Discard/defer quietly; do not publish a stale result |
| Persistence failure | Ignore after preserving the current in-memory advisory result |
| Delivery failure | Defer acknowledgement so the advisory finding remains eligible |

Every mapping message is capped at 240 Unicode code points and contains no raw
failure payload. Unexpected defects remain defects until the outer Pi adapter
contains them with the existing fail-open result.

## Runtime conformance

`npm run architecture:check` uses the TypeScript syntax tree to find `Effect.run*`
calls through named imports, aliases, namespace imports, property access, and
element access while ignoring comments and strings. It scans `src` only. M7.7
makes `src/effect/runtime-boundary.ts` the sole production/test execution adapter,
asserts exactly one `ManagedRuntime.make` factory, and removes `src/extension.ts`
from the direct-runtime allowlist. Production facades receive that managed
runtime; isolated compatibility tests receive the explicit test runner.

Tests and package-certification probes are isolated test boundaries and may run
or import Effect. Future migration slices should extend detection only when a new
syntax needs coverage; widening the production allowlist requires an explicit
architecture review. See [Effect-owned resources](effect-resources.md).
