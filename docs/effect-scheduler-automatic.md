# Effect-owned scheduling and automatic checks

Issue [#68](https://github.com/revazi/pi-jscpd/issues/68) moves dirty-generation
scheduling, automatic changed checks, interruption, and delivery transactions to
Effect. This is the fifth release-blocking migration slice; M7.6 composes the
application workflows, and M7.7 supplies the single managed extension runtime.

## Scheduler ownership

`JscpdScanScheduling` owns one immutable scheduler state in `MutableRef` and
starts automatic work as fibers in its supplied scope. The state retains only:

- the lifecycle epoch;
- latest changed and terminally attempted generations;
- at most one pending latest-generation request;
- at most one active automatic fiber and its host-cancellation `AbortController`;
- whether a next-tick start is queued; and
- the closed state.

A zero-duration sleep through injected `JscpdClock` replaces the former
`queueMicrotask`, preserving the next-tick coalescing window without creating an
unmanaged timer. `JscpdClockLive` delegates to Effect's clock, while tests supply
a deterministic layer. A second request
for a newer dirty generation replaces a pending request. An active request may
have only one coalesced successor.

Cancellation advances the lifecycle epoch, discards pending work, aborts the
host signal, and interrupts the active fiber. Deferred, interrupted, or
stale work does not consume its generation. Non-interruption task failure remains
a quiet terminal attempt, matching the prior fail-open behavior. Explicit scans
interrupt scheduler-owned automatic work before entering the existing serialized
jscpd adapter; they do not share automatic cancellation ownership.

The scheduler requires an owned Effect scope and exposes only native programs.
Production supplies a scope owned by the extension runtime; scoped-layer tests
and characterization drivers supply their own test scopes. Throwing task
construction is suspended inside the task failure/finalizer chain so ownership
always returns to idle and later generations can proceed.

## Automatic check composition

`JscpdAutomaticChecking` composes the changed-command call, retry eligibility,
current-generation checks, and result handling as one Effect program. The default extension path submits this program directly to the Effect
scheduler. Promise characterization exists only in test-support adapters.

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

The architecture check rejects `new Promise`, `queueMicrotask`, direct global
timer creation, runtime dependencies, and Promise service contracts in
`src/scheduler.ts` and `src/automatic.ts`.

`test/effect-scheduler-automatic.test.ts` covers pending-generation coalescing,
scoped interruption, retry eligibility, Effect-layer changed checks, quiet Pi
delivery with `triggerTurn: false`, acknowledgement-after-delivery ordering, and
typed delivery failure. Existing scheduler, automatic, extension lifecycle, and
characterization tests continue to lock the public behavior.
