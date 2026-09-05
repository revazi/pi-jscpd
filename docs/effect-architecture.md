# Effect architecture and conformance

Status: **implemented and locally recertified; package remains private and unreleased**

`pi-jscpd` uses Effect 3.22.1 for fallible asynchronous work, resource ownership,
cancellation, concurrency, and shared service workflows. jscpd remains the source
of truth for clone detection, while deterministic parsing, normalization,
comparison, registry data, and presentation remain plain TypeScript.

This document describes the final architecture. Migration issue history belongs
in Git and the local maintainer roadmap rather than the published package.

## Runtime topology

Each extension instance owns exactly one `ManagedRuntime` created in
`src/effect/runtime-boundary.ts`. Its production layer graph supplies:

- `JscpdProcess` for shell-free bounded child-process execution;
- `JscpdFileSystem` for canonical paths, metadata, bounded reads/writes,
  restrictive temporary directories, and cleanup; and
- `JscpdClock` for timeouts and scheduling.

Pi tool, slash-command, lifecycle, and overlay adapters execute native programs
through that runtime. Infrastructure, domain, and application modules never call
`Effect.run*` or create independent runtimes. Isolated test execution lives under
`test/support/`.

Promise workflow orchestration is intentionally limited to three reviewed files:

- `src/extension.ts` — imperative Pi callbacks and tracked shutdown coordination;
- `src/overlay.ts` — the callback-driven TUI adapter; and
- `src/effect/filesystem.ts` — Node filesystem promises wrapped by typed effects
  and bracketed handle ownership.

The AST architecture gate enforces these boundaries and rejects Promise service
contracts, nested Effect runners, unmanaged timers, and direct filesystem access
from migrated modules.

## Services and layers

Infrastructure services own effects and resources:

- analyzer resolution and capability probing;
- bounded process-tree execution;
- report workspace creation, reading, and removal;
- filesystem/configuration access;
- lifecycle cancellation and time; and
- narrow Pi persistence/delivery callbacks.

Domain owners maintain one bounded state implementation each:

- baseline generation and deferred completion;
- changed-file project generation and canonical file set;
- acknowledgement branch scope and revision;
- verification checkpoints;
- session mode and last-check status; and
- Fallow coexistence policy and notice state.

Application programs compose scan, changed comparison, status/session controls,
automatic checkpoints, scheduling, and refactor verification. Service effects
retain their process/filesystem requirements until the host runtime supplies the
production layers.

## Resource and cancellation ownership

Every analyzer child is acquired and finalized by `JscpdProcess`. Execution uses
argument arrays with `shell: false`, bounds combined output and time, propagates
interruption, sends TERM before bounded KILL escalation, checks remaining process
roots, destroys abandoned streams, and detaches listeners.

Each analyzer run is serialized by an Effect semaphore. It creates a mode-0700
workspace outside the project, supplies one fixed report path, reads only a
bounded regular non-symlink artifact, consumes the report before cleanup, and
removes the workspace on success, failure, timeout, cancellation, invalidation,
or disposal. Cleanup uncertainty overrides an otherwise valid result.

Bounded file reads use `acquireUseRelease`. Acquisition is bracketed, an in-flight
read settles before the handle closes, and a handle acquired after interruption
is closed without starting the read. Typed filesystem and size failures map to
bounded report/configuration outcomes.

Automatic checks run as scoped scheduler fibers. The scheduler owns one active
and one latest pending generation, coalesces through `JscpdClock`, interrupts only
its own automatic work when explicit scans take priority, and leaves interrupted,
stale, or deferred generations retryable. Task construction and result delivery
are suspended inside failure/finalizer boundaries so defects cannot strand active
ownership.

Quiet baseline capture is host-launched but explicitly tracked. Branch changes
invalidate and await prior baseline settlement before replacement work starts;
shutdown awaits baseline finalizers before disposing scheduler, capability,
analyzer, and runtime resources. Shutdown is idempotent.

## Failure and privacy contract

Expected operational failures use tagged Effect errors for analyzer, process,
filesystem, cancellation, timeout, limits, invalid input, stale work, workspace,
persistence, and delivery conditions. Application and host boundaries translate
them to the existing bounded fail-open result unions.

Unexpected defects are contained only at reviewed outer workflow/host boundaries.
Public output never includes raw exceptions, child output, environment values,
source fragments, internal fingerprints, or temporary paths. Interruption remains
distinct from ordinary failure so resource finalizers run and stale work cannot
commit state.

Automatic delivery rechecks generation, branch, idle state, and pending messages;
appends findings with `triggerTurn: false`; commits acknowledgements only after
successful delivery; and treats persistence/footer failures as advisory. Clean
and failed automatic checks stay out of model context.

## Conformance evidence

The final non-publishing gate passes on Node 22.19.0 and 24.12.0 with the pinned
Pi 0.84.4, TypeBox 1.3.7, Effect 3.22.1, and jscpd 5.1.2 fixtures. Evidence covers:

- strict TypeScript and Biome checks;
- architecture, documentation-link, and repository-hygiene gates;
- 423 network-free tests, including cancellation and finalizer regressions;
- Fallow dead-code, architecture, security, and full-audit checks;
- a production dependency audit with no reported vulnerabilities; and
- exact private `0.0.0` tarball installation and runtime certification through
  RPC, tool, TUI-compatible, JSON, and print paths, package-owned jscpd probing,
  active process-tree shutdown, and temporary-report cleanup.

Certification proves only the reviewed source/artifact state. It does not close
tracking issues or authorize `0.1.0`, removal of `private: true`, a tag, a GitHub
release, npm authentication, or publication. Those remain separate explicit
maintainer decisions under [the release policy](release.md).
