# Effect conformance audit — M7.8 complete

This is the source-conformance record after command/status,
scheduler/automatic, analyzer workspace/report, and production test-runtime
facade removal. Subsequent M7.9 recertification passed on the unreleased branch;
that evidence is not publication authorization.

## Reviewed paths

| Area | Evidence | Disposition |
| --- | --- | --- |
| Production execution | `src/effect/runtime-boundary.ts` constructs the managed runtime; host adapters execute programs; isolated runners live under `test/support/` | Removed production test defaults; architecture checks guard lower-level execution bridges |
| Automatic scheduling | `src/scheduler.ts` forks coalescing and active work into its supplied scope; disposal interrupts active work and closes the factory-owned scope | Native finalization/repeated-disposal coverage exists; audit regression now covers throwing task construction and subsequent-generation progress |
| Automatic delivery | `src/automatic.ts` preserves interruption, defers failed delivery, and commits acknowledgements after delivery | Construction failure is suspended inside the handler's fail-open boundary |
| Command cancellation | `src/dispatch.ts` races the caller signal, removes its listener, and maps interruption to public cancellation results | Native tool cancellation/finalization and construction-failure tests pass |
| Child processes | `src/process.ts` acquires children with `acquireUseRelease`, races execution against an Effect timeout, and finalizes with bounded TERM/KILL settlement | Ownership is explicit; platform/descendant recertification is still required |
| Filesystem | `src/effect/filesystem.ts` owns file handles with `acquireUseRelease`, creates restrictive temporary directories, and has typed filesystem/limit failures | Controlled-handle tests prove interrupted acquisition is released and in-flight bounded reads settle before close |
| Analyzer workspaces and reports | `src/jscpd.ts` scopes workspace acquisition/release and now uses only `JscpdFileSystem` effects for canonicalization, metadata, bounded no-follow reads, and recursive cleanup | Direct Node filesystem workflows and the Promise cleanup seam are removed; the Effect-only/filesystem architecture gates cover this module |
| Background baseline/probes | `src/extension.ts` tracks every quiet baseline `runPromiseExit`, invalidates it at branch/lifecycle boundaries, and awaits accumulated settlement before starting replacement branch work or disposing the adapter | A managed-runtime regression holds a baseline finalizer open and proves adapter disposal waits; command-triggered probes remain owned by their awaited command fibers |

## Confirmed gap fixed in this audit slice

A native scheduler task could throw before its `onExit` handler was installed.
The dead fiber then left the owner marked active and prevented later generations
from running. Suspending task construction inside the existing failure/finalizer
chain preserves quiet terminal-failure behavior and releases scheduler ownership.
A native regression test checks both settlement and next-generation progress.

The Effect-only service gate now also covers `scheduler.ts`, `automatic.ts`, and
`jscpd.ts`; the earlier concurrency/filesystem gates alone did not reject runner
dependencies or Promise contracts in those modules.

## Conformance conclusion

- Promise workflow orchestration is restricted by AST checks to
  `src/extension.ts`, `src/overlay.ts`, and `src/effect/filesystem.ts`. The first
  two are imperative Pi/TUI adapters. The filesystem boundary wraps Node promises
  in typed effects and brackets file handles; interruption tests cover both late
  acquisition and in-flight read settlement.
- Runtime calls and managed-runtime construction remain confined to
  `src/effect/runtime-boundary.ts`. Test execution lives outside production under
  `test/support/`.
- Mutable domain/application transitions use their single reviewed owners;
  synchronous bounded state access does not duplicate asynchronous workflows.
  Expected operational failures retain typed channels until their established
  fail-open mapping, while boundary defects are bounded without exposing payloads.
- The architecture gate, TypeScript checks, focused interruption/finalizer tests,
  full test suite, and Fallow architecture/dead-code/audit checks pass with no
  obsolete exports or reported boundary violations.

## M7.9 recertification evidence

- `npm run release:check` passes on Node 22.19.0 and 24.12.0 with 423 tests.
- Both exact-tarball runs install and exercise the private `0.0.0` package with
  pinned Effect 3.22.1, package-owned jscpd 5.1.2, Pi 0.84.4, all supported host
  modes, active process-tree shutdown, and temporary-report cleanup.
- `npm audit --omit=dev --audit-level=high`, Fallow security, Fallow architecture,
  and Fallow full audit report no findings.
- Markdown links, repository hygiene, private package state, architecture checks,
  strict types, and Biome pass.

No version, privacy, publication, public command, or persistence-format changes
are authorized by this audit or recertification.
