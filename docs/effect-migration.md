# Effect migration guide

Status: **in progress, release-blocking**

Parent issue: [#63](https://github.com/revazi/pi-jscpd/issues/63)

Release impact: `0.1.0` is postponed until every ordered migration issue and final recertification are complete.

## Goal

Move `pi-jscpd` to one coherent Effect runtime architecture without changing its
public behavior. Effect should own fallible asynchronous work, resources,
cancellation, concurrency, and shared mutable service state. jscpd remains the
clone-detection authority, and Pi remains the host lifecycle authority.

“Move everything to Effect” does **not** mean wrapping every function in
`Effect.succeed`. Pure parsing, report normalization, clone comparison, command
registry data, and rendering transformations should remain ordinary TypeScript.
The migration is complete when every operation that actually depends on time,
I/O, cancellation, resources, concurrency, or lifecycle state is composed as an
Effect program.

## Non-negotiable contracts

Every migration slice must preserve:

- the `jscpd_run` tool and `/jscpd` command contract;
- status-first bare `/jscpd` behavior with no implicit scan;
- advisory, read-only, quiet, deterministic, polyglot, and fail-open defaults;
- strict project containment, bounded input/output, and source-fragment omission;
- existing jscpd configuration and detection semantics;
- one serialized analyzer/process owner;
- generation-safe baselines, automatic checks, and acknowledgements;
- branch-local bounded session persistence;
- no runtime package download or `npx` execution; and
- complete process-tree and temporary-report cleanup at shutdown.

A behavior change discovered during migration requires its own explicit product
decision. It must not be hidden inside an architectural conversion.

## Target architecture

One extension instance owns one managed runtime and root scope:

```text
Pi command/tool/event/TUI adapters
               │
               ▼
       managed Effect runtime
               │
     application workflow layer
 scan · changed · status · automatic
               │
      domain service layer
 baseline · attribution · acknowledgements · verification
               │
   infrastructure service layer
 process · temp workspace · filesystem · clock · jscpd route
               │
               ▼
        operating system / jscpd
```

### Runtime boundary

`Effect.run*` belongs only in explicit Pi adapters and isolated test helpers.
Infrastructure, domain, and application modules return effects and declare their
requirements. They must not create private runtimes.

Pi cancellation must be bridged to fiber interruption. Session shutdown must
interrupt active fibers and close the root scope exactly once, while retaining
the existing bounded graceful-then-forced child-process teardown.

### Services and layers

Use `Context` service tags to describe capabilities and `Layer` values to provide
production or deterministic test implementations. Prefer narrow capabilities,
for example:

- process execution and process-tree termination;
- temporary report workspace ownership;
- bounded filesystem access and canonical path resolution;
- clock/timing;
- analyzer route resolution;
- baseline and session-domain state; and
- Pi message/session ports needed by application workflows.

Construct the production layer graph once in `src/extension.ts`. Tests should
replace only the relevant service layers rather than patching globals.

### Errors and defects

Expected operational failures belong in typed error channels. Tags should remain
stable enough to map once to the current public result reasons, including:

- missing or incompatible analyzer;
- cancellation or timeout;
- output/report limits;
- invalid configuration, path, or report;
- stale/invalidation outcomes;
- temporary-workspace or cleanup uncertainty; and
- bounded persistence/delivery failure.

Unexpected bugs and violated internal invariants may remain defects. Do not use a
broad catch at every layer to erase expected error detail, and do not expose raw
exceptions, child output, environment values, or local paths to users.

Illustrative shape only—the foundation issue owns the exact names and APIs:

```ts
import { Context, Data, Effect, Layer } from "effect";

class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  readonly reason: "spawn" | "timeout" | "output-limit";
}> {}

class ProcessService extends Context.Tag("pi-jscpd/ProcessService")<
  ProcessService,
  {
    readonly run: (
      request: ProcessRequest,
    ) => Effect.Effect<ProcessResult, ProcessFailure>;
  }
>() {}

const ProcessTest = Layer.succeed(ProcessService, deterministicProcess);
```

### Resource ownership

Use scoped acquire/release semantics for resources that must always settle:

- child processes and their process groups;
- temporary report directories/files;
- timers and timeout races;
- event listeners and cancellation bridges;
- background fibers; and
- the extension runtime/root scope.

Finalizers must be idempotent, bounded where the operating system can stall, and
tested under success, typed failure, interruption, timeout, and shutdown.

### State and concurrency

Use Effect state/concurrency primitives only where asynchronous ownership needs
them. Preserve simple immutable values and pure reducers. The target must retain:

- one serialized adapter queue;
- explicit work priority over automatic work;
- dirty-generation coalescing;
- stale-result rejection;
- acknowledgement commit only after successful delivery; and
- lifecycle reset without global singleton state.

## Ordered migration

Each issue is independently reviewable and must leave `main` green. Do not begin
a dependent issue before its prerequisites are stable.

### Step 1 — Foundation and characterization ([#64](https://github.com/revazi/pi-jscpd/issues/64))

Implemented on the unreleased branch: exact Effect `3.22.1`, declarative service
and expected-error contracts, deterministic test layers, behavior
characterization, package certification, and the initial runtime-boundary gate.
See the [foundation contract](effect-foundation.md). No production workflow or
managed runtime is introduced by this step.

1. Review and exact-pin one Effect 3.x version.
2. Add compatibility, lockfile, dependency-policy, and package checks.
3. Define service tags, layer ownership, typed error taxonomy, and the approved
   runtime boundary.
4. Add deterministic process/filesystem/clock/Pi test layers.
5. Expand characterization tests before converting production code.
6. Add an initial architecture check for allowed `Effect.run*` locations.

Exit with no production behavior change.

### Step 2 — Process and analyzer resources ([#65](https://github.com/revazi/pi-jscpd/issues/65))

Implemented on the unreleased branch: scoped process and report-workspace
acquisition, interruption-safe process-tree finalization, Effect semaphore
serialization, scoped jscpd/capability layers, generation-safe probing, and one
explicit temporary application runtime bridge. See
[Effect-owned resources](effect-resources.md).

Migrate `process.ts`, `jscpd.ts`, and `capability.ts`. Convert process ownership,
timeout/interruption, output bounds, temporary report workspaces, adapter
serialization, route probing, and capability caching. Remove the superseded
internal Promise resource path in the same change.

Exit only after process-tree and report cleanup tests pass under interruption and
shutdown.

### Step 3 — Filesystem and decoding boundaries ([#66](https://github.com/revazi/pi-jscpd/issues/66))

Implemented on the unreleased branch: one live bounded-filesystem layer now owns
trusted configuration and Fallow signal reads, canonical path/metadata access,
report source-path resolution, and exact clone-identity source ranges. Typed
filesystem/limit failures are mapped to the unchanged bounded diagnostics and
rejections, while deterministic parsing, normalization, comparison, and
rendering remain ordinary TypeScript. See the
[filesystem and decoding boundary](effect-filesystem.md).

Trust gates, no-follow checks, canonical containment, strict schemas, atomic
configuration rejection, source-fragment omission, and byte limits remain
unchanged. Remaining compatibility Promise callers delegate to the same effects
through the managed host runtime or explicit isolated-test runner.

### Step 4 — Stateful domain services ([#67](https://github.com/revazi/pi-jscpd/issues/67))

Implemented on the unreleased branch: Effect service layers now own baseline
generations/deferred completion, changed-file project generations,
acknowledgement revisions, and verification checkpoints. Immutable domain values
and pure comparisons remain plain TypeScript. Versioned session snapshot parsing
and migration stay deterministic, while persistence has a typed `JscpdPiPort`
program. See [Effect-owned domain state](effect-domain-state.md).

Temporary Promise-compatible facades delegate to the same Effect state owners;
the superseded mutable closures and Promise-held baseline completion path are
removed. State versions, capacity limits, stale completion, partial restoration,
branch reset, and verification behavior remain unchanged.

### Step 5 — Scheduler and automatic checks ([#68](https://github.com/revazi/pi-jscpd/issues/68))

Implemented on the unreleased branch: dirty-generation coalescing, explicit-work
priority, lifecycle invalidation, retry eligibility, and background ownership now
use scoped Effect fibers. Automatic changed checks and acknowledgement-after-delivery
transactions compose as effects, including typed Pi delivery with
`triggerTurn: false`. The `agent_settled` handler remains a non-blocking eligibility
signal. See [Effect-owned scheduling and automatic checks](effect-scheduler-automatic.md).

### Step 6 — Application workflows ([#69](https://github.com/revazi/pi-jscpd/issues/69))

Implemented on the unreleased branch: scan, changed, status/session controls,
Fallow coexistence, report decoding, and verification now compose as Effect
application services. The default path uses native capability, adapter,
filesystem, domain-state, and command effects; compatibility Promise conversion
remains only at the temporary application edge. Public fail-open result objects
and pure presentation/comparison functions are unchanged. See
[Effect-composed application workflows](effect-application-workflows.md).

### Step 7 — Pi and TUI boundary ([#70](https://github.com/revazi/pi-jscpd/issues/70))

Implemented on the unreleased branch: each extension instance owns one managed
runtime and production process/filesystem/clock layer graph. Commands, tools,
lifecycle work, automatic fibers, and effectful overlay actions use that runtime;
Pi cancellation interrupts native command fibers, and idempotent shutdown awaits
owned finalizers before disposing the runtime scope. Imperative Pi registration
and TUI rendering remain callback-driven. See
[Managed Effect runtime and Pi boundary](effect-managed-runtime.md).

### Step 8 — Legacy removal and conformance ([#71](https://github.com/revazi/pi-jscpd/issues/71))

Search the whole source tree for temporary adapters, duplicate factories,
floating promises/fibers, unmanaged processes/timers/listeners, broad error
erasure, forbidden `Effect.run*`, and obsolete tests/types. Remove them and make
the architecture check authoritative.

### Step 9 — Pre-release recertification ([#72](https://github.com/revazi/pi-jscpd/issues/72))

Review all public Markdown and local `.agents`/`AGENTS.md` guidance against the
final implementation. Run the complete supported-Node, security, architecture,
and exact-tarball gates. Certification must exercise real package-owned jscpd,
Effect interruption/finalizers, Pi modes, process-tree shutdown, and report
cleanup.

Keep `0.0.0` and `private: true`. Finishing this step does not authorize `0.1.0`
or publication.

## Per-slice working method

For every implementation issue:

1. Re-read this guide and the issue dependencies.
2. Identify observable contracts and add missing characterization tests first.
3. Introduce the smallest service/effect boundary needed for that slice.
4. Provide production and deterministic test layers.
5. Bridge temporarily only at an approved outer boundary.
6. Delete the superseded internal implementation in the same slice.
7. Test success, no-findings, typed failure, defect containment, cancellation,
   timeout, interruption, finalization, and lifecycle invalidation as applicable.
8. Update relevant architecture, compatibility, security, and user guidance.
9. Run standard checks and leave `main` green.

Avoid a repository-wide mechanical rewrite. Avoid long-lived dual paths. Small,
dependency-ordered vertical slices make regressions attributable and reviewable.

## Review checklist

A migration PR is not complete unless reviewers can answer yes:

- Does this use Effect for a real effect/resource/concurrency concern?
- Are service requirements explicit and supplied by a layer?
- Are expected failures typed without leaking sensitive diagnostics?
- Are acquired resources scoped and finalizers interruption-safe?
- Is there exactly one runtime boundary for the production path?
- Was the old internal path removed?
- Did pure deterministic code remain simple?
- Are public behavior and bounds unchanged?
- Do deterministic tests cover interruption and finalizer behavior?
- Are relevant docs and issue dependencies current?

## Release gate

The existing `npm run release:check` and manual readiness workflow remain useful,
but they are insufficient while [#63](https://github.com/revazi/pi-jscpd/issues/63)
is open. A first release can be considered only after issues #64–#72 close and a
separate maintainer decision explicitly authorizes versioning and publication.
