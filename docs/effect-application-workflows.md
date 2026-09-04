# Effect-composed application workflows

Issue [#69](https://github.com/revazi/pi-jscpd/issues/69) composes explicit scan,
changed comparison, status/session controls, Fallow coexistence, and verification
as Effect application programs. This is the sixth release-blocking migration
slice; the Pi/TUI adapter still receives one managed runtime and final layer graph
in M7.7.

## Application services

The migration adds narrow application tags and layers:

- `JscpdScanWorkflow` validates project scopes, probes the analyzer, runs the
  bounded adapter, decodes its report, renders the public result, and records an
  optional verification checkpoint.
- `JscpdChangedWorkflow` serializes the complete baseline/current comparison,
  retains branch and acknowledgement revisions, attributes changed paths,
  presents only eligible new groups, and commits bounded acknowledgements.
- `JscpdStatusWorkflow` inspects capability/configuration/coexistence state and
  owns bounded last-check state.
- `JscpdSessionMode` owns the current configuration/session override in one
  `MutableRef` owner.
- `JscpdFallowWorkflow` evaluates trusted overlap signals and owns its bounded
  current policy/notice state.

The existing `JscpdCommandExecutor` gains a temporary optional `executeEffect`
path. Default scan, changed, status-aware, and automatic composition uses that
path directly. Injected legacy test adapters may still provide only `execute`;
the compatibility conversion occurs once at the application edge.

## End-to-end effect path

Scan scope canonicalization and metadata checks now use `JscpdFileSystem` rather
than direct Node filesystem promises. Capability and adapter interfaces expose
their already-implemented Effect methods to application composition. The jscpd
request also accepts an Effect report consumer, so production scan, changed, and
baseline paths decode and normalize reports without starting a nested Promise
workflow.

The application programs retain public fail-open result objects as their success
values. Infrastructure result unions are mapped once by the existing pure
capability, adapter, baseline, and presentation mappings. Unexpected failures at
an injected compatibility boundary become the same bounded process/baseline
failure result and never expose exceptions, child output, environment values, or
source fragments.

Verification scope reads and compare-and-remember updates now have one shared
Effect adapter over the M7.4 owner. Pure clone comparison, result presentation,
registry data, and help rendering remain plain TypeScript.

## Serialization and lifecycle behavior

The changed workflow replaces its Promise-tail queue with an Effect semaphore.
The branch scope and verification scope are captured before waiting for the
permit, preserving stale queued-work rejection. The underlying jscpd adapter
remains the only process serializer and resource owner.

Cancellation continues through the caller `AbortSignal` into capability and
adapter services. Lifecycle, acknowledgement revision, baseline availability,
and partial identity checks retain their existing bounded public outcomes.
Status recording and session controls execute transactionally in the status-aware
Effect workflow before the host receives its result.

## Compatibility and conformance

Promise facades call the same Effect workflow owner through
`src/effect/runtime-boundary.ts`; they do not maintain a second implementation.
M7.7 removes those facades from the production path when the extension constructs
one managed runtime and supplies all layers.

The architecture check now enforces that scan, changed, status, Fallow,
baseline-capture, and verification workflow modules contain no async-function or
Promise-chain orchestration. It also includes scan scope handling in the
shared-filesystem boundary.

`test/effect-application-workflows.test.ts` exercises scan, changed, status,
Fallow, and native command execution through application effects. Existing
scan/changed/status/Fallow/verification, automatic, extension, and package tests
continue to characterize all public messages, limits, cancellation results, and
branch-local behavior.
