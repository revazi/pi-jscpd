# Effect filesystem and decoding boundaries

Issue [#66](https://github.com/revazi/pi-jscpd/issues/66) moves trusted
configuration, path canonicalization, report-path normalization, clone source
reads, and supported Fallow signal inspection behind the shared bounded
filesystem service. This is the third release-blocking Effect migration slice;
M7.7 now supplies the managed extension runtime.

## Live filesystem layer

`src/effect/filesystem.ts` is the only Node filesystem adapter for the migrated
boundaries. `JscpdFileSystemLive` provides typed canonicalization, metadata,
bounded reads and writes, temporary-directory creation, and removal.

Bounded reads:

- open paths with `O_NOFOLLOW` when requested;
- require regular files when requested;
- check a declared byte maximum before allocation and after reading;
- support exact bounded ranges for clone identity without reading whole source
  files;
- acquire and close file handles with `Effect.acquireUseRelease`; and
- translate expected Node failures to `JscpdFileSystemFailure` or
  `JscpdLimitExceeded` without retaining paths or raw exceptions.

Canonical containment remains the caller's responsibility because each caller
owns the relevant project root. Configuration, report, clone-identity, and
Fallow readers canonicalize first and reject paths outside that root before a
bounded read.

## Decoding and trust

Untrusted projects still return defaults without any filesystem operation.
Trusted project and local configuration files are independently bounded and
decoded, and an invalid file is rejected atomically before precedence merging.
Diagnostics retain the existing bounded codes and never include file content or
private paths.

jscpd JSON bytes are parsed and schema-checked by ordinary deterministic
functions. Only project/source path resolution is effectful. Validation failures
remain body-free and map to the existing report rejection reasons; unexpected
defects are not converted into sensitive public diagnostics.

Clone identity reads only the exact validated source range, capped at 1 MiB,
and continues to mark incomplete identities conservatively. Supported Fallow
configuration and package signals remain capped at 64 KiB; unsupported JSONC or
TOML signals stay ambiguous rather than being guessed.

## Compatibility boundary

Promise-facing compatibility helpers delegate to Effect-returning functions
through the explicit test runner in `src/effect/runtime-boundary.ts`. There is no
parallel legacy filesystem implementation and no lower `Effect.run*` call.
Production application workflows use the extension instance's single managed
runtime and `JscpdFileSystemLive` layer.

## Verification

`test/effect-filesystem.test.ts` uses the deterministic filesystem layer to
cover trust gating, configuration merge/decode, report rejection and project
validation, exact clone-source reads, and Fallow signals. It also exercises the
live no-follow boundary. Existing config, path, report, clone-identity, Fallow,
scan, baseline, and changed-result tests continue to lock the public behavior.
The architecture check rejects new direct Node filesystem imports in migrated
modules outside `src/effect/filesystem.ts`.
