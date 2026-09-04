# Compatibility policy

`pi-jscpd` deliberately has a narrow, tested host contract. The package uses
Pi's extension, event, tool, custom-message, and TUI APIs directly, so an open
peer range would imply compatibility that has not been verified.

## Package identity and ownership

The canonical package name is **`pi-jscpd`**. The source and package metadata are
owned and maintained by [Revaz Zakalashvili](https://github.com/revazi) at
[`revazi/pi-jscpd`](https://github.com/revazi/pi-jscpd). A public npm lookup
returned no existing package when this name was selected, but a lookup does not
reserve a name.

The package remains at version `0.0.0` with `"private": true`. It must not be
published or treated as reserved until the release-blocking
[Effect migration](effect-migration.md) is complete and separate release approval
removes that guard after the maintainer controls the npm name. The current manual
readiness workflow has no publication permission or credentials. The source
remains MIT licensed regardless of publication state; see the
[release preparation policy](release.md).

## Supported and tested matrix

| Component | Supported range | Tested fixture | Notes |
| --- | --- | --- | --- |
| Node.js | `>=22.19.0 <23 || >=24 <25` | `22.19.0`, `24.12.0` | Node 22.19.0 is Pi 0.84.4's minimum; Node 24 is the second supported LTS line. |
| `@earendil-works/pi-coding-agent` | `>=0.84.4 <0.85.0` | `0.84.4` | The supported 0.84 patch line only. |
| `@earendil-works/pi-ai` | `>=0.84.4 <0.85.0` | `0.84.4` | Kept on the same tested Pi release line. |
| `@earendil-works/pi-tui` | `>=0.84.4 <0.85.0` | `0.84.4` | Required by the interactive overlay. |
| `typebox` | `>=1.3.7 <2` | `1.3.7` | Required by the agent-tool schema. |
| `effect` | Exact `3.22.1` | `3.22.1` | Reviewed MIT runtime for scoped process/analyzer, bounded-filesystem, lifecycle domain-state, scheduling, automatic delivery, and application workflows; the single managed Pi runtime lands in M7.7. |
| `jscpd` | Compatible v5 | `5.1.2` | Exact runtime dependency and fallback analyzer. |

Effect `3.22.1` was the npm registry's current stable 3.x release when foundation
issue [#64](https://github.com/revazi/pi-jscpd/issues/64) selected it. Installed
package metadata confirms its MIT license, and the lockfile preserves the
reviewed registry integrity. See the [foundation contract](effect-foundation.md)
for dependency evidence, service/error contracts, and runtime-boundary policy.
No open range or automatic upgrade is implied.

The Pi and TypeBox packages remain peer dependencies so the extension uses the
host Pi installation instead of bundling a second runtime. Development
dependencies pin the exact tested fixtures. Effect and jscpd are normal, exact
runtime dependencies; installing `pi-jscpd` provides the reviewed composition
foundation and analyzer without a later network request.
`npm run compatibility:check` verifies the active Node version, peer ranges,
aligned Pi fixture versions, installed fixture versions, locked Effect metadata
and integrity, and the pinned jscpd runtime before type checking and tests.

The supported ranges cover the Node 22 and 24 LTS lines, not the intervening
non-LTS Node 23 line. They are a contract, not a claim that every patch
combination was run separately. The minimum Node release and the current Node 24 fixture receive
the full project check; Pi 0.84.4 is the API fixture. A future Pi `0.85` release,
Node 25 release, or TypeBox 2 release requires an explicit compatibility review
and range update rather than being accepted automatically.

## Packed-artifact certification

`npm run pack:certify` tests the artifact that would be published, not the source
checkout alone. Its disposable install resolves the exact declared jscpd version
through npm just as a user installation would; runtime checks remain offline. It:

- compares `npm pack --json` output with the complete tracked runtime, license,
  and public-document allowlist, including regular-file modes and unsafe/private
  path rejection;
- installs that exact tarball with lifecycle scripts disabled in a restrictive
  disposable location and verifies exact, importable Effect `3.22.1` plus jscpd
  `5.1.2` dependencies;
- uses the locked Pi `0.84.4` CLI with isolated home, agent, session, and
  temporary directories and all resource discovery disabled except the explicit
  installed package;
- verifies `/jscpd` discovery and provider-free help/status behavior through RPC,
  exercises the registered `jscpd_run` contract, Effect-owned analyzer resources,
  and installed overlay component, proves the installed artifact resolves and
  probes bundled jscpd `5.1.2`, and
  checks JSON, print, and non-TUI fallback paths; and
- separately places a deterministic fake jscpd v5 executable on the disposable
  `PATH`, then stops Pi during an active scan and asserts that the process tree
  and every `pi-jscpd-*` report directory are gone.

The generated probe and fake executable remain certification fixtures for
controlled output and process-tree behavior; the bundled capability check runs
the real pinned jscpd release. CI runs this certification on both supported Node
fixtures. The certification script itself is development tooling and is
deliberately excluded from the publishable file allowlist.

## Unsupported-version behavior

- npm uses `engines.node` and peer dependency ranges during installation. Based
  on the user's npm configuration, an unsupported Node or peer version may
  produce a warning or reject dependency resolution.
- The extension does not add a second runtime version detector or compatibility
  shim. A forced install outside the declared ranges is unsupported and may fail
  to load if Pi's API or Node's runtime behavior changed.
- Once the extension loads on a supported host, its ordinary operational errors
  remain advisory and fail open. That runtime policy does not turn an
  unsupported host into a supported one.
- The adapter first checks compatible project-local and `PATH` installations,
  then falls back to the package-owned jscpd `5.1.2` dependency. A missing or
  damaged bundled dependency is reported without breaking the Pi session; the
  extension never invokes `npx` or downloads an analyzer at runtime.

## Updating compatibility

A support-range or Effect-runtime change must:

1. update `engines`, peer ranges, exact development fixtures, and the exact
   reviewed Effect dependency as applicable;
2. run `npm install` so the lockfile records those fixtures;
3. pass `npm run check` at the minimum supported Node version and the current
   supported Node LTS fixture;
4. run `npm run pack:certify` to smoke-test the exact tarball, extension loading,
   representative command/tool/UI behavior, and shutdown cleanup with the
   candidate Pi version; and
5. update this matrix, Effect architecture checks, and release notes; and
6. run the non-publishing `npm run release:check` gate documented in
   [the release policy](release.md).

Do not widen peer ranges solely because installation succeeds. Pi lifecycle and
TUI behavior must be exercised before a new release line is declared supported.
