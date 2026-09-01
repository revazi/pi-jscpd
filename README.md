# pi-jscpd

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)
[![status: capability probe](https://img.shields.io/badge/status-capability%20probe-orange.svg)](#project-status)

> A Pi-native, polyglot duplication guardrail powered by jscpd.

`pi-jscpd` is planned as a quiet advisory layer for the Pi coding agent. It will
detect duplicate code introduced during an agent session, point Pi to the
existing implementation, and support the normal inspect → refactor → test →
rescan flow.

## Project status

**Capability probe — scan execution is not implemented yet.**

The extension registers `/jscpd` and the `jscpd_run` agent tool from one typed
`scan` command registry. On the first explicit scan request in a project/session,
it checks `jscpd --version` and then `cpd --version` only when `jscpd` is missing.
The shell-free probe is time- and output-bounded, requires jscpd major version 5,
and returns normalized missing, incompatible, cancelled, timeout, or failure
outcomes without exposing command output or environment details. Results are
cached for the current cwd and `PATH` and invalidated at session boundaries.
Nothing runs during module loading or extension registration.

Real duplication analysis remains unavailable even when a compatible executable
is found. Bare `/jscpd` only explains that the interactive overlay is reserved;
it never starts a scan.

The package name is provisional. npm publication is disabled intentionally
until naming and compatibility are decided. The source repository is public
under the MIT License.

## Why this should be a Pi extension

jscpd already provides the duplication engine. The extension's job is to add the
workflow that a generic command or MCP connection does not provide:

- notice which files Pi changed;
- compare the repository before and after the session;
- report new clone groups instead of historic debt;
- keep clean checks out of the model context;
- make findings easy for Pi to inspect and verify;
- preserve existing `.jscpd.json` policy across local, agent, and CI usage.

The intended result is a guardrail users can install and then largely forget.

## Intended user experience

Once implemented, the minimal path should look like this:

```text
pi install npm:pi-jscpd
pi
```

The extension will use an existing `jscpd` or `cpd` v5 binary on `PATH`. It will
not download or install a binary. If neither command is available, Pi continues
normally and an explicit scan request explains the missing prerequisite. A
dedicated `/jscpd status` subcommand is planned but is not registered yet.

The implemented public scaffold is deliberately small:

```text
/jscpd             report that the future overlay is reserved; do not scan
/jscpd scan [args] validate and dispatch an explicit scan request
jscpd_run          agent tool with command `scan` and optional tokenized `args`
```

Both explicit surfaces currently run only the lazy capability check and then
return that scan execution is unavailable. They do not install anything or
search outside normal `PATH` command resolution. The tool schema accepts only
the `scan` command, an optional bounded string array, and no unknown fields.
Slash-command quotes group paths with spaces; neither surface constructs or
invokes a shell command.

Future `changed`, `status`, `off`, and `help` subcommands are not registered yet.
The bare `/jscpd` command remains reserved for an interactive overlay; its exact
views and controls will be agreed in
[the overlay interaction issue](https://github.com/revazi/pi-jscpd/issues/25)
before that UI milestone is implemented.

## Defaults

- Advisory, never an automatic source edit.
- Quiet when no new duplication is found.
- Existing duplication is suppressed unless requested.
- Existing jscpd configuration is respected.
- Analysis is local and has no telemetry or network use.
- Errors fail open and do not break the Pi session.
- Fallow overlap is surfaced instead of silently double-reporting.

## Relationship to Fallow

Fallow overlaps with jscpd on duplication detection and combines it with broader
JavaScript/TypeScript analysis such as dead code, dependencies, complexity, and
architecture checks.

This project is narrower: a Pi-native duplication workflow using jscpd's
polyglot and embedded-format coverage. In repositories already using Fallow for
duplication, the extension should offer an explicit scope or remain on demand so
users do not receive duplicate findings.

## Repository layout

```text
.
├── src/
│   ├── index.ts           thin Pi extension entrypoint
│   ├── extension.ts       slash-command and tool registration
│   ├── registry.ts        typed command metadata
│   ├── contract.ts        strict jscpd_run schema
│   ├── parser.ts          bounded shell-free token parsing
│   ├── dispatch.ts        command and capability dispatch boundary
│   └── capability.ts      bounded executable/version probe and session cache
├── test/                  package and command-contract tests
├── biome.json             formatting and lint policy
├── LICENSE                MIT License
├── package.json           Pi package manifest
├── tsconfig.json
└── README.md
```

## Start developing

Prerequisites:

- Node.js 22 or newer
- Pi
- jscpd v5 for future integration smoke tests

Install development dependencies and verify the capability slice:

```text
npm install
npm run format       # apply Biome formatting and safe fixes
npm run lint         # check formatting, lint rules, and import organization
npm run check        # typecheck, Biome, and tests
```

Biome is pinned in `devDependencies` so local and CI checks use the same version.

Load the current extension directly in Pi:

```text
pi -e ./src/index.ts
```

The command contract and lazy jscpd v5 capability probe are now in place; the
next milestones add the bounded read-only scanner and structured reports. The
bare `/jscpd` overlay is tracked separately in
[issue #25](https://github.com/revazi/pi-jscpd/issues/25) so its interaction
design can be agreed before implementation. Development is tracked in the
[GitHub issue tracker](https://github.com/revazi/pi-jscpd/issues); automatic hooks
come only after the on-demand path is reliable.

## Contributing

Start from an open issue and keep each change focused. Add or update tests for
behavioral changes, run `npm run check`, and describe user-visible behavior in
this README.

Keep the initial package small. Do not reimplement clone detection, automatically
install jscpd, or add source mutation to the extension.

## Maintainer and project links

Maintained by [Revaz Zakalashvili](https://github.com/revazi).

- [Source repository](https://github.com/revazi/pi-jscpd)
- [Issue tracker and roadmap](https://github.com/revazi/pi-jscpd/issues)
- [jscpd](https://github.com/kucherenko/jscpd)
- [Pi coding agent](https://github.com/earendil-works/pi)

## License

[MIT](./LICENSE) © 2026 Revaz Zakalashvili
