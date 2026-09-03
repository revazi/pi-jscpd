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
published or treated as reserved until the separate release approval removes
that guard and the maintainer controls the npm name. The source remains MIT
licensed regardless of publication state.

## Supported and tested matrix

| Component | Supported range | Tested fixture | Notes |
| --- | --- | --- | --- |
| Node.js | `>=22.19.0 <23 || >=24 <25` | `22.19.0`, `24.12.0` | Node 22.19.0 is Pi 0.84.4's minimum; Node 24 is the second supported LTS line. |
| `@earendil-works/pi-coding-agent` | `>=0.84.4 <0.85.0` | `0.84.4` | The supported 0.84 patch line only. |
| `@earendil-works/pi-ai` | `>=0.84.4 <0.85.0` | `0.84.4` | Kept on the same tested Pi release line. |
| `@earendil-works/pi-tui` | `>=0.84.4 <0.85.0` | `0.84.4` | Required by the interactive overlay. |
| `typebox` | `>=1.3.7 <2` | `1.3.7` | Required by the agent-tool schema. |

The Pi and TypeBox packages remain peer dependencies so the extension uses the
host Pi installation instead of bundling a second runtime. Development
dependencies pin the exact tested fixtures. `npm run compatibility:check`
verifies the active Node version, peer ranges, aligned Pi fixture versions, and
installed fixture versions before type checking and tests.

The supported ranges cover the Node 22 and 24 LTS lines, not the intervening
non-LTS Node 23 line. They are a contract, not a claim that every patch
combination was run separately. The minimum Node release and the current Node 24 fixture receive
the full project check; Pi 0.84.4 is the API fixture. A future Pi `0.85` release,
Node 25 release, or TypeBox 2 release requires an explicit compatibility review
and range update rather than being accepted automatically.

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
- jscpd is an external executable, not an npm dependency of this package. The
  adapter independently requires an installed jscpd v5-compatible `jscpd` or
  `cpd` command and reports missing or incompatible binaries without breaking
  the Pi session.

## Updating compatibility

A support-range change must:

1. update `engines`, peer ranges, and exact development fixtures together;
2. run `npm install` so the lockfile records those fixtures;
3. pass `npm run check` at the minimum supported Node version and the current
   supported Node LTS fixture;
4. smoke-test extension loading and representative command/UI behavior with the
   candidate Pi version; and
5. update this matrix and release notes.

Do not widen peer ranges solely because installation succeeds. Pi lifecycle and
TUI behavior must be exercised before a new release line is declared supported.
