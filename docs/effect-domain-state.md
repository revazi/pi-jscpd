# Effect-owned domain state

Issue [#67](https://github.com/revazi/pi-jscpd/issues/67) moves lifecycle-bound
baseline, changed-file, acknowledgement, verification, and branch-session state
to Effect service layers. This is the fourth release-blocking migration slice;
scheduler composition lands in M7.5; application composition and the single
managed extension runtime remain later ordered slices.

## Ownership model

Each service factory creates exactly one owner backed by Effect state primitives.
The Effect layer and temporary Promise-compatible facade delegate to that same
owner; there is no second legacy state implementation.

- `JscpdBaseline` owns one generation, current immutable baseline value, active
  cancellation controller, and `Deferred` completion.
- `JscpdChangedFiles` owns one project generation, canonical roots, and an
  immutable bounded file set in `MutableRef`.
- `JscpdAcknowledgements` owns branch scope, transaction revision, and bounded
  opaque findings in `MutableRef`.
- `JscpdVerification` owns lifecycle scope and one immutable checkpoint per
  explicit scan kind in `MutableRef`.

Layers create independent owners, so state cannot cross extension instances.
Existing branch/session lifecycle calls still restore or reset the corresponding
owner exactly once.

## Baseline generations

A baseline start replaces the prior generation before asynchronous work begins.
The owner stores a `Deferred` shared by the starter and current waiters. Disable,
invalidation, layer release, or caller-fiber interruption aborts active work and
settles that generation as lifecycle-cancelled. A completion can commit only when
both its generation and active-capture identity still match.

M7.6 exposes the capability and adapter effects directly to application
workflows; temporary Promise facades remain only for host compatibility. Their
cancellation is linked to the baseline fiber. Project canonicalization
and content identity indexing now compose directly with `JscpdFileSystem` and the
Effect identity program from M7.3. Public baseline states and failure reasons are
unchanged.

## Changed-file attribution

Project roots and successful built-in `write`/`edit` targets are canonicalized
through `JscpdFileSystem`. Each pending path operation captures a generation and
root identity before I/O, then commits against the latest state atomically. A
reset or project restart makes stale completion inert. The 1,000-file cap,
portable-path validation, symlink containment, sorting, and append-only behavior
are unchanged.

## Acknowledgement transactions and verification

Acknowledgement reconciliation checks the expected revision and performs its
bounded retain/add transaction in one synchronous Effect state operation. A
competing reconciliation against the same revision therefore cannot commit.
Path invalidation and restoration increment revisions and branch scopes exactly
as before.

Verification retains only accepted identity snapshots. Partial snapshots do not
replace a checkpoint, lifecycle scopes reject stale completions, and matching
scope keys continue to report removed, remaining, new, and ambiguous groups via
pure comparison functions.

## Branch-local snapshots

Snapshot encoding, version 1/2 migration, strict version 3 decoding, and bounded
validation remain plain deterministic TypeScript. The new
`persistJscpdSessionStateEffect` sends an already-bounded snapshot through
`JscpdPiPort`, preserving typed `JscpdPersistenceFailure`. The Pi adapter will
adopt that port when M7.7 constructs the managed runtime; no global or filesystem
persistence was added.

## Compatibility bridge and tests

Promise-facing callers temporarily execute the Effect programs through
`src/effect/runtime-boundary.ts`. Synchronous acknowledgement and verification
calls use the same `MutableRef` owners directly, so no duplicate mutable closure
or Promise implementation remains. M7.5 consumes these acknowledgement owners
through Effect delivery transactions without adding parallel state.

`test/effect-domain-state.test.ts` covers competing acknowledgement revisions,
verification reset, concurrent changed-file attribution, baseline invalidation,
fiber interruption, accepted capture, and typed Pi persistence failure. Existing
baseline, changed-file, acknowledgement, verification, automatic, changed-flow,
and session-state tests continue to lock restoration, migration, capacity, stale
completion, and branch-isolation behavior.
