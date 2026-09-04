# Effect-composed application workflows

Issue [#69](https://github.com/revazi/pi-jscpd/issues/69) composes explicit scan,
changed comparison, status/session controls, Fallow coexistence, and verification
as Effect application programs. This is the sixth release-blocking migration
slice; M7.7 now supplies the Pi/TUI adapter's managed runtime and production
layer graph.

## Application services

The migration adds narrow application tags and layers:

- `JscpdScanWorkflow` validates project scopes, probes the analyzer, runs the
  bounded adapter, decodes its report, renders the public result, and records an
  optional verification checkpoint.
- `JscpdChangedWorkflow` serializes the complete baseline/current comparison,
  retains branch and acknowledgement revisions, attributes changed paths,
  presents only eligible new groups, and commits bounded acknowledgements.
- `JscpdStatusWorkflow` inspects capability/configuration/coexistence state,
  leaves its process requirement injectable, and owns generation-checked bounded
  last-check state.
- `JscpdSessionMode` owns the current configuration/session override in one
  `MutableRef` owner.
- `JscpdFallowWorkflow` evaluates trusted overlap signals and owns its bounded,
  generation-checked current policy/notice state.

The existing `JscpdCommandExecutor` gains a temporary optional `executeEffect`
path. Default scan, changed, status-aware, and automatic composition uses that
path directly. Injected legacy test adapters may still provide only `execute`;
the compatibility conversion occurs once at the application edge.

## End-to-end effect path

Scan scope canonicalization and metadata checks now use `JscpdFileSystem` rather
than direct Node filesystem promises, and stop at the first rejected target as
before. Capability and adapter interfaces expose their already-implemented
Effect methods to application composition. The adapter leaves both process and
filesystem requirements injectable. Its request also accepts an Effect report
consumer, so production scan, changed, and baseline paths decode and normalize
reports without starting a nested Promise workflow.

The application programs retain public fail-open result objects as their success
values. Infrastructure result unions are mapped once by the existing pure
capability, adapter, baseline, and presentation mappings. Unexpected failures at
an injected compatibility boundary become the same bounded process/baseline
failure result and never expose exceptions, child output, environment values, or
source fragments.

Acknowledgement scope/revision/findings/reconciliation, changed-file snapshots,
and verification scope/compare updates now expose shared Effect adapters over
their M7.4 owners. Pure clone comparison, result presentation, registry data,
and help rendering remain plain TypeScript.

## Serialization and lifecycle behavior

The changed workflow replaces its Promise-tail queue with an Effect semaphore.
The branch scope and verification scope are captured before waiting for the
permit, preserving stale queued-work rejection. The underlying jscpd adapter
remains the only process serializer and resource owner.

Cancellation continues through the caller `AbortSignal` into capability and
adapter services. Lifecycle, acknowledgement revision, baseline availability,
and partial identity checks retain their existing bounded public outcomes.
Status recording rejects completions from a restored branch scope, and reset or a
newer evaluation prevents stale Fallow inspection from replacing current policy.
Session controls execute transactionally in the status-aware Effect workflow
before the host receives its result.

## Compatibility and conformance

Promise facades call the same Effect workflow owner through
`src/effect/runtime-boundary.ts`; they do not maintain a second implementation.
M7.7 keeps these facades only as host compatibility surfaces and supplies the
same extension-owned managed runtime to each; native command composition does
not invoke them internally.

The architecture check now enforces that scan, changed, status, Fallow,
baseline-capture, and verification workflow modules contain no async-function,
Promise construction/static combinator, or Promise-chain orchestration. It also
includes scan scope handling in the shared-filesystem boundary.

`test/effect-application-workflows.test.ts` exercises scan, serialized changed,
status, Fallow, lifecycle freshness, and native command execution through
application effects. Adapter tests prove native report consumption, bounded
defect mapping, and workspace cleanup. Existing
scan/changed/status/Fallow/verification, automatic, extension, and package tests
continue to characterize all public messages, limits, cancellation results, and
branch-local behavior.
