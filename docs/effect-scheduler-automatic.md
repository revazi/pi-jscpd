# Effect-owned scheduling and automatic checks

Issue [#68](https://github.com/revazi/pi-jscpd/issues/68) moves dirty-generation
scheduling, automatic changed checks, interruption, and delivery transactions to
Effect. This is the fifth release-blocking migration slice; M7.6 composes the
application workflows, while the single managed extension runtime remains M7.7.

## Scheduler ownership

`JscpdScanScheduling` owns one immutable scheduler state in `MutableRef` and
starts automatic work as fibers in its supplied scope. The state retains only:

- the lifecycle epoch;
- latest changed and terminally attempted generations;
- at most one pending latest-generation request;
- at most one active automatic fiber and its compatibility `AbortController`;
- whether a next-tick start is queued; and
- the closed state.

A zero-duration sleep through injected `JscpdClock` replaces the legacy
`queueMicrotask`, preserving the next-tick coalescing window without creating an
unmanaged timer. `JscpdClockLive` delegates to Effect's clock, while tests supply
a deterministic layer. A second request
for a newer dirty generation replaces a pending request. An active request may
have only one coalesced successor.

Cancellation advances the lifecycle epoch, discards pending work, aborts the
compatibility signal, and interrupts the active fiber. Deferred, interrupted, or
stale work does not consume its generation. Non-interruption task failure remains
a quiet terminal attempt, matching the prior fail-open behavior. Explicit scans
interrupt scheduler-owned automatic work before entering the existing serialized
jscpd adapter; they do not share automatic cancellation ownership.

The temporary Promise-compatible scheduler facade creates an owned Effect scope
through `src/effect/runtime-boundary.ts`. The production layer instead receives
the extension scope. M7.7 removes the compatibility scope when the extension
constructs its one managed runtime and root layer graph.

## Automatic check composition

`JscpdAutomaticChecking` composes the changed-command call, retry eligibility,
current-generation checks, and result handling as one Effect program. The default
extension path submits this program directly to the Effect scheduler. Promise
facades remain only for compatibility with existing host-facing tests and injected
adapters until the application and Pi boundary slices finish.

Baseline-pending and cancellation outcomes remain deferred. Other bounded clean,
finding, unavailable, timeout, and failure results consume the covered generation
only after current result handling completes. Fiber interruption propagates to the
scheduler-owned abort signal, so stale work cannot publish side effects.

## Delivery and acknowledgements

Automatic acknowledgement staging now uses one `MutableRef` transaction owner.
Reads still see current branch acknowledgements, while reconciliation writes are
staged with their expected revision. The Effect delivery program performs these
steps in order:

1. recheck lifecycle freshness, Pi idle state, and pending messages;
2. verify the staged acknowledgement revision;
3. append an actionable finding with `triggerTurn: false`;
4. commit acknowledgements only after successful delivery;
5. record and persist bounded advisory state; and
6. update optional footer status.

Clean and failed outcomes never send a model-context message. Typed Pi delivery
failure returns `deferred`, discards no source acknowledgement state, and leaves
the generation eligible. Persistence and footer failures remain advisory after a
successful delivery. Effect interruption is never converted into a terminal
attempt by these fail-open mappings.

## Conformance and tests

The architecture check rejects `new Promise`, `queueMicrotask`, and direct global
timer creation in `src/scheduler.ts` and `src/automatic.ts`. Temporary Promise
signatures may wrap already-owned Effect programs only through the approved runtime
boundary.

`test/effect-scheduler-automatic.test.ts` covers pending-generation coalescing,
scoped interruption, retry eligibility, Effect-layer changed checks, quiet Pi
delivery with `triggerTurn: false`, acknowledgement-after-delivery ordering, and
typed delivery failure. Existing scheduler, automatic, extension lifecycle, and
characterization tests continue to lock the public behavior.
