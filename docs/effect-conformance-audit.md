# Effect conformance audit — M7.8 in progress

This is a source-audit checkpoint after the command/status and
scheduler/automatic facade removal (`c49a536`), not release certification.
The full suite at that checkpoint passed 417 tests on Node 24.12.0.
Supported-Node and packed-artifact recertification remain M7.9 work.

## Reviewed paths

| Area | Evidence | Disposition |
| --- | --- | --- |
| Production execution | `src/effect/runtime-boundary.ts` constructs the managed runtime; host adapters execute programs; isolated runners live under `test/support/` | Removed production test defaults; architecture checks guard lower-level execution bridges |
| Automatic scheduling | `src/scheduler.ts` forks coalescing and active work into its supplied scope; disposal interrupts active work and closes the factory-owned scope | Native finalization/repeated-disposal coverage exists; audit regression now covers throwing task construction and subsequent-generation progress |
| Automatic delivery | `src/automatic.ts` preserves interruption, defers failed delivery, and commits acknowledgements after delivery | Construction failure is suspended inside the handler's fail-open boundary |
| Command cancellation | `src/dispatch.ts` races the caller signal, removes its listener, and maps interruption to public cancellation results | Native tool cancellation/finalization and construction-failure tests pass |
| Child processes | `src/process.ts` acquires children with `acquireUseRelease`, races execution against an Effect timeout, and finalizes with bounded TERM/KILL settlement | Ownership is explicit; platform/descendant recertification is still required |
| Filesystem | `src/effect/filesystem.ts` owns file handles with `acquireUseRelease`, creates restrictive temporary directories, and has typed filesystem/limit failures | Multi-step Promise reads remain beneath the infrastructure service; interruption/settlement needs a dedicated audit test |
| Analyzer workspaces and reports | `src/jscpd.ts` scopes workspace acquisition/release and now uses only `JscpdFileSystem` effects for canonicalization, metadata, bounded no-follow reads, and recursive cleanup | Direct Node filesystem workflows and the Promise cleanup seam are removed; the Effect-only/filesystem architecture gates cover this module |
| Background baseline/probes | `src/extension.ts` launches baseline work with an unawaited `runPromiseExit`; baseline invalidation and capability disposal signal cancellation | Shutdown settlement of these host-launched fibers needs explicit proof; runtime disposal alone is not accepted as proof |

## Confirmed gap fixed in this audit slice

A native scheduler task could throw before its `onExit` handler was installed.
The dead fiber then left the owner marked active and prevented later generations
from running. Suspending task construction inside the existing failure/finalizer
chain preserves quiet terminal-failure behavior and releases scheduler ownership.
A native regression test checks both settlement and next-generation progress.

The Effect-only service gate now also covers `scheduler.ts`, `automatic.ts`, and
`jscpd.ts`; the earlier concurrency/filesystem gates alone did not reject runner
dependencies or Promise contracts in those modules.

## Ordered remaining work

1. Prove baseline/probe cancellation settlement at session shutdown and branch
   changes, including work still probing before the adapter starts. If host-launched
   fibers are not awaited, give the host explicit scoped ownership and finalization.
2. Finish the filesystem interruption audit: cancellation must not leave a Promise
   read loop running against a closed handle or permit late resource acquisition.
3. Audit remaining mutable service transitions, typed expected failures versus
   defect recovery, and obsolete types/factories across the source tree. Expand
   architecture enforcement only after each module satisfies its gate.
4. Run the complete conformance checks and document any remaining exceptions
   before claiming M7.8 complete. Then perform M7.9 supported-Node, security,
   public/local documentation, and exact-tarball recertification.

No version, privacy, publication, public command, or persistence-format changes
are authorized by this audit.
