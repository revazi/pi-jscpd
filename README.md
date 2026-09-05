# pi-jscpd

[![CI](https://github.com/revazi/pi-jscpd/actions/workflows/ci.yml/badge.svg)](https://github.com/revazi/pi-jscpd/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)

A quiet, read-only duplication guardrail for the [Pi coding agent](https://github.com/earendil-works/pi), powered by [jscpd](https://github.com/kucherenko/jscpd).

`pi-jscpd` detects duplicate blocks introduced during a Pi session, shows both
locations, and helps you inspect, refactor, test, and verify the result. jscpd
remains the source of truth for tokenization, clone detection, supported
languages, and statistics.

> **Pre-release status:** the implementation, Effect migration, and
> non-publishing recertification are complete on the unreleased branch. The package
> remains private at `0.0.0`; no `0.1.0` proposal or publication is authorized by
> migration or certification success.

## Install

```sh
pi install npm:pi-jscpd
```

The package includes pinned jscpd `5.1.2` and Effect `3.22.1` runtime
dependencies—there is no separate analyzer installation and no runtime download.
Effect owns bounded process execution, analyzer probing, temporary report
workspaces, adapter serialization, trusted configuration and signal reads,
canonical source-path validation, baseline generations, changed-file attribution,
acknowledgement transactions, verification checkpoints, scoped scheduling,
automatic finding delivery, scan/changed/status/Fallow application workflows,
and one managed runtime/layer graph per extension instance. Legacy Promise/service
paths are removed from those layers, and host-launched baseline work is settled at
lifecycle boundaries. If your project already installs
a compatible jscpd locally, or `jscpd`/`cpd` is available on `PATH`, the
extension uses that installation first and keeps the bundled version as a
fallback.

Start Pi in your project and verify the setup:

```text
/jscpd status
```

If no compatible binary is available, the extension stays dormant and Pi
continues normally.

## Usage

Run `/jscpd` to open the interactive overview. Opening it shows status only; it
never starts an implicit scan.

| Command | Purpose |
| --- | --- |
| `/jscpd` | Open the responsive overview |
| `/jscpd changed` | Show unacknowledged duplication introduced this session |
| `/jscpd scan` | Scan the whole project |
| `/jscpd scan src tests` | Scan specific in-project files or directories |
| `/jscpd status` | Show binary, configuration, mode, and last-check status |
| `/jscpd off` | Disable scans for the current session |
| `/jscpd on` | Re-enable scans for the current session |
| `/jscpd help` | Show command help |

Pi can use the same operations through the `jscpd_run` tool:

```json
{
  "command": "scan",
  "args": ["src"]
}
```

Supported tool commands are `scan`, `changed`, `status`, `off`, `on`, and
`help`.

## How session checks work

At session start, the extension captures one bounded, in-memory project baseline.
It then tracks successful writes and edits made through Pi's built-in `write`
and `edit` tools.

After Pi settles, one coalesced background check compares the current project
with the baseline:

- clean checks stay out of model context;
- failures remain advisory and available through `/jscpd status`;
- new duplicate blocks are reported with both locations;
- existing repository duplication is omitted from changed-only results; and
- actionable automatic findings never trigger a surprise model turn.

Displayed findings are acknowledged for the active conversation branch so the
same unchanged block is not repeatedly reported. Baselines, source bytes,
verification checkpoints, and reports are never persisted.

Manual edits, shell commands, custom mutation tools, deletes, and renames are not
attributed because Pi does not provide a stable structured file list for them.
Use `/jscpd scan` when changes happened outside built-in `write` or `edit`.

## Interactive overview

Bare `/jscpd` opens a bounded TUI with:

- current mode, binary, configuration, and last-check status;
- changed-project scan actions;
- searchable finding and detail views;
- both duplicate locations, size, format, and session relationship;
- session enable/disable controls; and
- cancellation and narrow-terminal support.

The overview never edits source, writes jscpd configuration, runs project tests,
or refactors automatically. In RPC, JSON, and print modes, explicit subcommands
remain available and the bare command uses a bounded non-interactive fallback.

## Configuration

Project configuration is optional:

```text
.pi/jscpd-guardrail.json
```

Use `.pi/jscpd-guardrail.local.json` for an ignored local override. Configuration
is read only after Pi trusts the project.

```json
{
  "enabled": true,
  "timeoutMs": 30000,
  "maxFindings": 10,
  "fallowCoexistence": "auto"
}
```

| Setting | Default | Allowed values |
| --- | ---: | --- |
| `enabled` | `true` | Boolean |
| `timeoutMs` | `30000` | Integer from `100` to `300000` |
| `maxFindings` | `10` | Integer from `1` to `100` |
| `fallowCoexistence` | `auto` | `auto`, `on-demand`, or `allow` |

Clone thresholds, formats, ignore rules, and other detection policy belong in
jscpd's normal configuration, such as `.jscpd.json` or package-level jscpd
settings. The extension does not maintain a parallel clone policy.

## Fallow coexistence

Pi Fallow can also detect duplication. With the default `auto` policy,
`pi-jscpd` conservatively detects supported signs of active Fallow duplication
analysis and moves automatic jscpd checks to on-demand mode to avoid duplicate
warnings.

Explicit `/jscpd changed`, project scans, and scoped scans remain available. Set
`fallowCoexistence` to `allow` when both automatic analyzers are intentional, or
`on-demand` to disable automatic jscpd checks explicitly.

See [Fallow coexistence](docs/fallow-coexistence.md) for the supported signals
and limitations.

## Safety and privacy

- Advisory and read-only by default.
- Never downloads packages at runtime or mutates source.
- Invokes binaries with argument arrays, never a shell command string.
- Keeps reports in restrictive temporary directories and removes them after
  success, failure, timeout, cancellation, or shutdown.
- Bounds process time, output, report size, findings, paths, and persisted state.
- Omits source fragments, raw child output, temporary paths, and internal
  fingerprints from results.
- Reads extension configuration only for trusted projects.
- Fails open so analyzer problems do not break the Pi session.

## Requirements

| Component | Supported |
| --- | --- |
| Node.js | `>=22.19.0 <23` or `>=24 <25` |
| Pi packages | `>=0.84.4 <0.85.0` |
| TypeBox | `>=1.3.7 <2` |
| Effect | Exact reviewed `3.22.1` runtime foundation |
| jscpd | Bundled `5.1.2`; compatible project-local or `PATH` v5 installations are preferred |

See the [compatibility policy](docs/compatibility.md) for the exact tested
fixtures and certification matrix.

## Development

```sh
npm ci --ignore-scripts
npm run format
npm run docs:check
npm run repo:hygiene
npm run check
npm run pack:certify
```

`npm run check` includes the Effect runtime-boundary architecture gate.
`npm run release:check` runs the complete non-publishing readiness gate. Tests
are network-free and use deterministic fake jscpd executables and Effect layers.

Useful documentation:

- [Effect architecture and conformance](docs/effect-architecture.md)
- [Automatic checkpoint lifecycle](docs/automatic-checkpoint.md)
- [`/jscpd` overlay contract](docs/overlay-interaction.md)
- [Fallow coexistence](docs/fallow-coexistence.md)
- [Compatibility and packed-artifact certification](docs/compatibility.md)
- [Release preparation and publication policy](docs/release.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

The npm package is not published yet: it remains version `0.0.0` with
`"private": true`. The installation interface above is the intended package
contract, not a claim of current availability. No `0.1.0`, release, tag, or
publication is authorized by finishing the Effect migration or passing CI.

## License

[MIT](./LICENSE) © 2026 Revaz Zakalashvili
