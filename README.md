# pi-jscpd

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)
[![status: design scaffold](https://img.shields.io/badge/status-design%20scaffold-orange.svg)](#project-status)

> A Pi-native, polyglot duplication guardrail powered by jscpd.

`pi-jscpd` is planned as a quiet advisory layer for the Pi coding agent. It will
detect duplicate code introduced during an agent session, point Pi to the
existing implementation, and support the normal inspect → refactor → test →
rescan flow.

## Project status

**Design scaffold — not functional yet.**

The repository currently provides the Pi package manifest, a loadable no-op
entrypoint, package-contract tests, and this product outline. It does not scan
code or register public commands yet.

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
normally and `/jscpd status` explains the missing prerequisite.

The proposed public surface is deliberately small:

```text
/jscpd             open the interactive jscpd overlay
/jscpd scan        scan on demand
/jscpd changed     show duplication introduced by this session
/jscpd status      show capability and configuration status
/jscpd off         disable automatic checks for this session
/jscpd help        show commands and usage
```

Following Pi Fallow's interaction pattern, Pi will also receive one `jscpd_run`
tool with a compact command-and-args contract rather than several always-visible
tools. The bare `/jscpd` command is reserved for an interactive overlay, as in
other Pi extensions; its exact views and controls will be agreed in
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
│   └── index.ts           public Pi extension entrypoint
├── test/
│   └── package.test.ts    package contract tests
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

Install development dependencies and verify the scaffold:

```text
npm install
npm run format       # apply Biome formatting and safe fixes
npm run lint         # check formatting, lint rules, and import organization
npm run check        # typecheck, Biome, and tests
```

Biome is pinned in `devDependencies` so local and CI checks use the same version.

Load the current no-op entrypoint directly in Pi:

```text
pi -e ./src/index.ts
```

The first implementation milestone is the read-only `/jscpd scan` command plus
the matching `scan` command in the `jscpd_run` tool. The bare `/jscpd` overlay
is tracked separately in [issue #25](https://github.com/revazi/pi-jscpd/issues/25)
so its interaction design can be agreed before implementation. Development is
tracked in the
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
