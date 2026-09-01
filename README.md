# pi-jscpd

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)
[![status: report validation](https://img.shields.io/badge/status-report%20validation-orange.svg)](#project-status)

> A Pi-native, polyglot duplication guardrail powered by jscpd.

`pi-jscpd` is planned as a quiet advisory layer for the Pi coding agent. It will
detect duplicate code introduced during an agent session, point Pi to the
existing implementation, and support the normal inspect → refactor → test →
rescan flow.

## Project status

**Bounded adapter and structured-report validation — user-facing scan execution is not implemented yet.**

The extension registers `/jscpd` and the `jscpd_run` agent tool from one typed
`scan` command registry. On the first explicit scan request in a project/session,
it checks `jscpd --version` and then `cpd --version` only when `jscpd` is missing.
The shell-free probe is time- and output-bounded, requires jscpd major version 5,
and returns normalized missing, incompatible, cancelled, timeout, or failure
outcomes without exposing command output or environment details. Results are
cached for the current cwd and `PATH` and invalidated at session boundaries.

An internal adapter can now serialize bounded child-process requests, consume a
size-limited report from a restrictive extension-owned temporary directory, and
clean up on completion, cancellation, timeout, invalidation, or shutdown. Its
jscpd v5 JSON consumer strictly validates statistics, clone pairs, locations,
and project-contained paths, then returns deterministic normalized data without
source fragments. It is lazy: module loading and extension registration create
no process or temporary directory. Real jscpd scan arguments and public scan
execution remain [issue #12](https://github.com/revazi/pi-jscpd/issues/12), so the
registered command and tool still stop after capability detection. Bare
`/jscpd` only explains that the interactive overlay is reserved; it never starts
a scan.

The package name is provisional. npm publication is disabled intentionally
until naming and compatibility are decided. The source repository is public
under the MIT License.

## Structured report contract

The initial structured reporter is jscpd v5 **JSON**. Authoritative
[jscpd v5.1.1 reporter source](https://github.com/kucherenko/jscpd/blob/v5.1.1/rust/crates/cpd-reporter/src/json_reporter.rs)
writes `<output>/jscpd-report.json` with required top-level `statistics` and
`duplicates` fields. The corresponding
[model source](https://github.com/kucherenko/jscpd/blob/v5.1.1/rust/crates/cpd-core/src/models.rs)
defines camel-case aggregate and per-format statistics. The
[v5.0.4 reporter source](https://github.com/kucherenko/jscpd/blob/v5.0.4/rust/crates/cpd-reporter/src/json_reporter.rs)
uses the same required shape; newer fields such as `isNew` and optional `summary`
are additive. JSON was selected over SARIF because JSON carries jscpd's authoritative
scan statistics as well as both clone occurrences. SARIF remains unsupported by
this consumer and is not silently treated as JSON.

The normalized internal report preserves jscpd's counts, percentages, format,
line/token size, and both line/column/offset spans. Reporter object order is
normalized, paths are canonical project-relative `/` paths, and source
`fragment`, blame, detection time, summaries, and other additive fields are not
retained. JSON does not expose SARIF's `jscpdCloneHash/v1`; stable baseline
identity remains a later milestone that can use the retained pair spans to hash
both occurrences rather than presenting a first-fragment digest as jscpd
evidence. Unknown additive fields are accepted where they cannot change the
required contract. Malformed variants, inconsistent clone counts, unsafe or
unverifiable paths, invalid ranges/numbers, duplicate JSON keys, ambiguous
clone records, and excessive collections are rejected with bounded typed
reasons.

jscpd v5 normally emits paths relative to its scan root and emits canonical
absolute paths with `--absolute`. For multi-format files, the authoritative
[finder source](https://github.com/kucherenko/jscpd/blob/v5.1.1/rust/crates/cpd-finder/src/orchestrate.rs)
qualifies synthetic source IDs as `<path>:<format>`, and its
[path helper](https://github.com/kucherenko/jscpd/blob/v5.1.1/rust/crates/cpd-core/src/paths.rs)
removes that suffix to read the source file. Because `:` is also legal in POSIX
filenames, the consumer checks both the literal path and format-qualified base:
it accepts one canonical in-project file (or two aliases of that same file) and
rejects two distinct file identities as ambiguous. Relative report paths are
resolved against the explicit project working directory, and every real file
must remain inside it. Issue #12 owns the real CLI arguments and must use that
path contract when adding path-scoped scans.

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
│   ├── capability.ts      executable/version probe and session cache
│   ├── process.ts         shared bounded child-process ownership
│   ├── jscpd.ts           serialized temporary-report adapter
│   └── jscpd-report.ts    strict v5 JSON validation and normalization
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

The command contract, lazy jscpd v5 capability probe, internal bounded
process/report lifecycle, and structured JSON validation are now in place. The
next milestone connects real read-only scan arguments and presentation without
changing the report parser.
The bare `/jscpd` overlay is tracked separately in
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
