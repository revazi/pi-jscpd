# Automatic advisory checkpoint decision

Status: **implemented with Effect-owned scheduling and automatic delivery**

Scope: lifecycle and process model

The completed Effect source migration preserves this trigger, generation,
quiet-delivery, cancellation, and shutdown contract. Scheduling/background work
uses scoped fibers and Effect transactions, application workflows compose native
programs, and Pi host adapters use one managed runtime.

## Decision

Use Pi's `agent_settled` event as the only automatic-checkpoint eligibility
signal. The handler must enqueue at most one generation-bound background check
and return immediately; it must not await a jscpd process.

Successful built-in `write` and `edit` results continue to mark the session
changed and increment a mutation generation. They do not start scans. At
`agent_settled`, the scheduler may start one check only when all of these remain
true:

- the session is enabled and trusted configuration has been restored;
- at least one attributable mutation is newer than the last terminal automatic
  attempt;
- the pre-session baseline is accepted;
- no automatic check already owns that mutation generation; and
- the extension runtime is still active and Pi is idle.

This makes the checkpoint **settled-triggered, dirty-coalesced, asynchronous,
and latest-generation-only**. Multiple writes in one agent run produce one
candidate check, not one process per write or model turn.

## Evidence

The decision was evaluated against Pi 0.84.4's installed extension
documentation, public type definitions, and `AgentSession` runtime.

Pi documents and types distinguish the candidate events as follows:

- `tool_result` occurs after each tool execution and can interleave for parallel
  tools.
- `turn_end` occurs after one assistant response and its tool results; another
  model/tool turn may start immediately.
- `agent_end` ends one low-level agent run, but retry, automatic compaction, or a
  queued continuation may still follow.
- `agent_settled` occurs only after retry, compaction retry, and queued steering
  or follow-up work are exhausted.
- `session_shutdown` is the teardown boundary for quit, reload, new, resume, and
  fork flows.

The installed `AgentSession` runtime drains post-run retries, compaction, and
queued messages before emitting `agent_settled`. Extension handlers are awaited,
so doing the scan directly in the handler would extend prompt settlement by as
much as the configured scan timeout. The handler therefore only schedules
owned background work and returns.

### Trigger cardinality

For one logical user request with `W` successful attributable writes, `T` model
turns, and `R` low-level runs caused by retry/compaction/queued continuations:

| Candidate | Trigger opportunities | Settled tree? | Result |
| --- | ---: | --- | --- |
| `tool_result` | `W` | No | Reject: scan stampede and parallel-tool races |
| `message_end` | user, assistant, and tool-result messages | No | Reject: noisy and not mutation-specific |
| `turn_end` | `T` | No | Reject: can delay or race the next model turn |
| `agent_end` | `R` | No | Reject: follow-ups and recovery may still mutate files |
| `agent_settled` | 1 after the logical run settles | Yes | **Select as eligibility signal** |
| next `before_agent_start` | 1 per later prompt | Previous run only | Reject as primary: delays the next user request |
| idle/debounce timer | timing-dependent | Not guaranteed | Reject: duplicates Pi's settled lifecycle and adds timer races |
| `session_shutdown` | 1 per teardown | Yes | Reject as scan trigger: too late to advise and conflicts with cleanup |

`agent_settled` gives the lowest safe trigger cardinality. A dirty generation is
still required because settled can occur after read-only work and because
automatic work may be cancelled and retried later.

## Runtime process model

### While Pi is active

1. A successful verified built-in mutation records its canonical project path,
   invalidates acknowledgements touching that path, increments the mutation
   generation, and marks automatic work dirty.
2. No automatic scan runs during assistant streaming, tool execution, retries,
   compaction recovery, steering, or queued follow-ups.
3. `agent_settled` asks the scheduler to cover the latest dirty generation and
   returns immediately.
4. The scheduler reuses the existing bounded capability probe, accepted
   baseline, full-project changed comparison, one serialized jscpd adapter, and
   temporary-report ownership.
5. A completion is accepted only if its runtime generation, branch scope,
   mutation generation, and project identity are still current.
6. Record a current terminal outcome—clean, findings, unavailable, timed out, or
   failed—as the automatic attempt for the covered generation. Do not retry the
   same unchanged generation after every later read-only prompt. Cancellation,
   supersession, or a stale completion does not consume the generation; a newer
   attributable mutation always becomes eligible.

No interval, filesystem watcher, long-lived jscpd server, or process starts from
the extension factory.

### A new run during a background check

A new accepted prompt or agent run supersedes an automatic check. Abort its
owned signal, leave that generation unattempted, and discard any late completion.
Cancellation should be requested before the new run can mutate files; cleanup
may finish through the serialized adapter without blocking the prompt.

Explicit `/jscpd` and `jscpd_run` operations also take priority over automatic
work. They may cancel the automatic owner and then use the same serialized
adapter. The automatic scheduler must never create a second process owner.

### Queued steering and follow-ups

Do nothing at intermediate `agent_end` events. Pi drains automatic retries,
automatic compaction retries, steering, and follow-up messages before
`agent_settled`, so all attributable mutations from that logical run coalesce
into the same latest dirty generation. Follow-up delivery mode does not create
an extra checkpoint between queued tasks.

### Reload, session replacement, branch navigation, and shutdown

- On reload, new, resume, or fork shutdown: close the scheduler first, abort its
  owned check, invalidate queued work, and await existing adapter cleanup. The
  replacement runtime restores only its active-branch state and creates a new
  scheduler generation.
- On `/tree` navigation: invalidate automatic work before restoring the target
  branch. A completion from the abandoned branch must never update or
  acknowledge the target branch.
- On quit: cancel and clean up only. Never start a final scan from
  `session_shutdown`.
- Shutdown remains idempotent and bounded by the existing child-process
  termination and cleanup model.

## Context and presentation policy

A clean automatic check must not call `pi.sendMessage()` and must not append a
message entry. It may update bounded internal session state and terminal status,
which stay outside model context.

A failed automatic check is also quiet by default. `/jscpd status` remains the
place to inspect bounded failure state; missing binaries stay dormant rather
than producing one warning per settled run.

For a new actionable finding, append one bounded custom finding message while
Pi is still idle with `triggerTurn: false`. Pi persists that message and includes
it in the next model context without starting a surprise LLM turn. It may also
be displayed immediately by supported UI modes. Before appending, recheck the
runtime, branch, mutation generation, and idle state; otherwise discard the
completion and keep the generation dirty.

Automatic acknowledgement must happen only after that durable finding message
is successfully appended. The explicit changed executor's current
"acknowledge on presentation" side effect therefore must not be reused blindly
by a background scheduler. Omitted findings remain unacknowledged.

## Rejected alternatives

### Scan on every successful write/edit result

This has the best proximity to a mutation but the worst multiplicity. Parallel
or rapid tool batches can request overlapping scans while the agent is still
working, and the result can become stale before it is presented.

### Scan at every turn end

A tool-using response can have many turns. Waiting in `turn_end` adds scan
latency directly between model turns; detaching the work introduces races with
the next tool batch. Dirty coalescing does not make an unsettled tree safe.

### Scan at agent end

`agent_end` is not a logical idle boundary. Pi may retry a provider error,
compact and retry, or continue queued messages after it. Triggering there can
scan intermediate source and duplicate work.

### Scan before the next user prompt

This sees the previous tree at rest but makes the user pay the full checkpoint
latency before work starts, and no check occurs if the session ends. It remains
a cancellation boundary, not the primary trigger.

### Debounce timer after mutation

A timer guesses idleness and must race streaming, queued messages, session
replacement, and process cleanup. Pi already exposes the stronger settled
signal, so an additional wall-clock debounce adds complexity without a better
safety guarantee.

### Scan during shutdown

The result has no reliable advisory destination, can prolong exit, and opposes
the invariant that shutdown only cancels and cleans owned work.

## Implementation boundary

M4.2 adds the bounded scheduler primitive: attributable mutations advance a
generation, repeated automatic requests coalesce to one active plus one latest
pending generation, explicit scans cancel only automatic ownership, deferred
completions remain retryable, and reset or shutdown rejects stale work.

M4.3 wires `agent_settled` to a detached automatic changed check. It reuses the
configured capability, baseline, timeout, finding cap, changed-file set, and
serialized adapter; cancellation or baseline-pending outcomes remain retryable,
while other terminal failures are consumed once per unchanged generation.
Lifecycle transitions cancel owned work and shutdown awaits bounded adapter
cleanup. Automatic findings are deliberately not acknowledged or injected yet.

M4.4 implements the presentation boundary. Automatic checks cap delivery at
five findings, prioritize groups whose two locations changed in the session,
and preserve deterministic size/location ordering within that priority. Clean
and failed outcomes update only bounded session/footer status. A current
finding result sends one custom message with `triggerTurn: false`, then commits
only the delivered acknowledgement identities; omitted findings remain
eligible. Non-TUI mode uses the same model-context message with transcript
display disabled. Delivery failure, queued work, a newer mutation, or a stale
lifecycle scope leaves the generation retryable without acknowledging it.

M7.5 replaces the scheduler's mutable Promise/microtask owner with scoped Effect
fibers, composes automatic checks directly through the scheduler's native Effect
path, and moves acknowledgement staging plus Pi delivery ordering to Effect. M7.7
supplies the managed host runtime, and M7.8 removes obsolete facade paths. See
[Effect-owned scheduling and automatic checks](effect-scheduler-automatic.md).

Focused tests cover coalescing, scheduler freshness, clean and failure status,
bounded finding delivery, repeated-finding suppression, non-TUI behavior,
scoped interruption, and acknowledgement-after-delivery ordering.

M6 must pin a Pi compatibility range that includes the documented
`agent_settled` contract. If that contract is unavailable or changes, remain
on-demand and revisit this decision; do not silently fall back to `agent_end`.

The lifecycle decision adds no separate configuration and does not change the
public command/tool contract.
