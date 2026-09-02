# pi-jscpd

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)
[![status: on-demand scans](https://img.shields.io/badge/status-on--demand%20scans-green.svg)](#project-status)

> A Pi-native, polyglot duplication guardrail powered by jscpd.

`pi-jscpd` is planned as a quiet advisory layer for the Pi coding agent. It will
detect duplicate code introduced during an agent session, point Pi to the
existing implementation, and support the normal inspect → refactor → test →
rescan flow.

## Project status

**Explicit scans, session tracking, baseline capture, and stable clone comparison are implemented.**

The extension registers `/jscpd scan`, `/jscpd status`, and the `jscpd_run` agent
tool from one typed command registry. On the first explicit scan or status
request in a project/session,
it checks `jscpd --version` and then `cpd --version` only when `jscpd` is missing.
The shell-free probe is time- and output-bounded, requires jscpd major version 5,
and returns normalized missing, incompatible, cancelled, timeout, or failure
outcomes without exposing command output or environment details. Results are
cached for the canonical project cwd and `PATH` and invalidated at session
boundaries.

A scan with no scopes analyzes the project. Optional arguments are existing file
or directory paths, not jscpd options. Every scope is resolved from the explicit
project cwd, must remain inside the project after symlink resolution, and is
passed after an argument separator. The extension keeps repository jscpd policy
in jscpd's own configuration and adds only its owned JSON reporter, absolute
report-path normalization, and temporary output directory. It never installs a
binary, invokes a shell, edits source, or writes a report into the project.

The bounded adapter serializes scans, validates jscpd v5 JSON statistics and both
clone locations, and removes its restrictive temporary workspace after success,
failure, timeout, cancellation, invalidation, or shutdown. Clone-positive exit
status is accepted only with a valid findings report. Tool and terminal output
come from the same normalized report, cap displayed findings, omit source
fragments, and include aggregate statistics plus both locations. Missing or
incompatible binaries, unsafe or unsupported paths, process failures, missing or
invalid reports, timeout, cancellation, and cleanup uncertainty fail open with
bounded diagnostics. Bare `/jscpd` remains reserved for the future overlay and
never starts a scan.

Trusted project and local extension settings are now loaded strictly at session
start. They can disable scanning, set the bounded per-run timeout, and cap
presented findings. Invalid sources are ignored atomically with a concise
warning; untrusted projects are never inspected for extension configuration.
`/jscpd status` reports the effective source and mode, the bounded binary name
and version state, and the session's latest clean, findings, cancelled, failed,
or never-run check without exposing child output or environment content.
`/jscpd off` disables scanning for the current session; status and help remain
available, and `/jscpd on` restores scanning without changing project files.
The session override, bounded last-check summary, and changed-file set are saved
as versioned Pi custom entries outside model context. Reload, resume, fork, and
`/tree` restore the latest valid snapshot on the active branch; a new branch
without one resets to trusted configuration, a never-run check, and no changed
files. Pre-tracking version 1 snapshots retain their mode and last-check state
while migrating to an empty changed-file set.

The changed-file tracker listens only to successful structured `tool_result`
events from Pi's active built-in `write` and `edit` tools. It uses the event's
structured `input.path` and `isError` fields, verifies built-in tool provenance,
and never parses result text, edit patches, or shell output. Existing targets
are resolved after the tool completes, must be regular files inside the
canonical project root, and are stored as bounded, deduplicated, portable
project-relative paths. In-project symlink aliases resolve to their canonical
target; lexical escapes and symlinks outside the project are rejected.

This is deliberately conservative. Manual edits, `!` commands, the `bash` tool,
and custom mutation tools are not attributed because Pi provides no stable
structured file list for their effects. The installed built-ins expose no
structured delete or rename operation. Tracked paths are therefore append-only:
a later unobserved delete or rename does not erase the source path, and a rename
destination is added only after its own successful built-in write/edit result.
If a result target is already missing or cannot be verified, it is ignored
rather than guessed. Explicit project scans remain the fallback for unobserved
filesystem changes.

After trusted session state is restored, the extension starts one full-project
baseline capture in the background without awaiting `session_start`, notifying
the user, or adding model context. Read-only work remains unblocked. Before an
active built-in `write` or `edit` executes, its `tool_call` waits for that same
bounded capture so the accepted report still describes the pre-mutation tree.
The capture reuses the installed-v5 probe, serialized scan adapter, strict JSON
normalization, configured timeout, and owned temporary-report cleanup.

Baseline state explicitly distinguishes pending, accepted clean/findings,
unavailable, partial, cancelled, timed-out, and failed outcomes. An accepted
normalized report is retained only in memory; no baseline artifact or source
fragment is persisted. Reload, resume, fork, or tree navigation with already
attributed changed files is marked partial instead of recapturing the modified
tree as an initial baseline. Lifecycle replacement cancels or discards stale
work, and all failures remain advisory. Stable clone identity and comparison are
implemented as an internal content-aware comparison layer. Each occurrence is
fingerprinted from its canonical project-relative path and the bounded source
bytes addressed by jscpd's normalized offsets; line, column, and offset values
are not identity inputs. Group fingerprints include format and jscpd's
line/token size plus the sorted occurrence identities, so occurrence order and
ordinary line movement do not change identity while changed block content does.

Comparison classifies uniquely identified groups as existing, new, or removed.
Unavailable source bytes, malformed/partial inputs, and repeated indistinguishable
groups remain explicitly ambiguous rather than being matched by report order.
The SHA-256 representation is opaque and internal: it is not persisted or
presented as a versioned jscpd identifier. `/jscpd changed` and acknowledgement
tracking remain the next milestone.

The package name is provisional. npm publication is disabled intentionally
until naming and compatibility are decided. The source repository is public
under the MIT License.

## Extension configuration

Extension behavior uses these optional files:

1. `.pi/jscpd-guardrail.local.json` — highest-precedence local override
2. `.pi/jscpd-guardrail.json` — project settings
3. built-in defaults

Pi's active project-trust decision is authoritative. The extension calls
`ctx.isProjectTrusted()` and reads neither file when project-local trust is not
active. It also rejects files that resolve outside the project, non-regular or
oversized files, malformed JSON, unknown fields, and invalid values. One invalid
file does not prevent a valid source at another precedence level from loading,
but an invalid file is never merged partially.

The minimal schema and defaults are:

```json
{
  "enabled": true,
  "timeoutMs": 30000,
  "maxFindings": 10
}
```

`timeoutMs` is an integer from 100 through 300000. `maxFindings` is an integer
from 1 through 100. These settings govern extension behavior only; clone modes,
thresholds, ignores, formats, and other detection policy remain in jscpd's own
supported configuration.

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
must remain inside it. The scan adapter requests absolute reporter paths and uses
that same explicit canonical project cwd for CLI execution, scope validation,
and report consumption.

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
normally; explicit scan and status requests explain the missing prerequisite.

The implemented public surface is deliberately small:

```text
/jscpd                       report that the future overlay is reserved; do not scan
/jscpd scan                  scan the project
/jscpd scan src "path here"  scan existing in-project files or directories
/jscpd status                show binary, config, mode, and last-check state
/jscpd off                   disable scanning for this session
/jscpd on                    re-enable scanning for this session
/jscpd help                  show generated command help
jscpd_run                    use the same scan, status, control, and help commands
```

The tool schema accepts only the `scan` command, an optional bounded string array,
and no unknown fields. Slash-command quotes group paths with spaces. Scope tokens
that look like options cannot override the extension-owned reporter or output
path; they are accepted only when they identify a real in-project file or
directory and are passed after `--`. Neither surface constructs a shell command.

The `off` and `on` controls are session-only overrides. While off, explicit scan
requests return a consistent disabled diagnostic instead of starting a process;
`status`, `help`, and `on` remain available. Pi custom entries preserve the
latest override, bounded last-check state, and canonical changed-file set on
each conversation branch, so reload, resume, fork, and tree navigation
reconstruct state from the active branch only. A genuinely new branch with no
snapshot uses the current trusted configuration, a never-run check, and an
empty changed-file set. Version 1 snapshots migrate their valid mode and
last-check state with an empty changed-file set. Capability caches, child
processes, temporary reports, and loaded configuration are never restored: they
are invalidated or cleaned
up, and configuration is loaded again under the current trust decision. The
changed-file set is internal groundwork; `/jscpd changed` is not registered yet.
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
│   ├── dispatch.ts        shared command dispatch boundary
│   ├── config.ts          trusted strict extension configuration loading
│   ├── capability.ts      executable/version probe and session cache
│   ├── process.ts         shared bounded child-process ownership
│   ├── jscpd.ts           serialized temporary-report adapter
│   ├── jscpd-report.ts    strict v5 JSON validation and normalization
│   ├── scan.ts            scope validation and end-to-end scan orchestration
│   ├── status.ts          capability, config, and last-check status state
│   ├── baseline.ts        ephemeral generation-safe initial report capture
│   ├── clone-identity.ts  internal content identity and baseline comparison
│   ├── changed-files.ts   bounded structured-event changed-file attribution
│   ├── session-state.ts   strict active-branch state snapshots and restoration
│   └── presentation.ts    bounded model and terminal summaries
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
- an already installed jscpd v5 (`jscpd` or `cpd`) for real scans

Install development dependencies and verify the scan slice:

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

The command contract, lazy jscpd v5 capability probe, bounded process/report
lifecycle, strict JSON validation, scope-safe scan orchestration, and concise
presentation, trusted extension configuration, branch-local session state
restoration, conservative changed-file tracking, and ephemeral initial baseline
capture and content-aware baseline comparison are in place. Tests use
deterministic fakes and do not download anything; a real installed v5 binary
can be used for a local scan smoke. Changed-only reporting, acknowledgement
tracking, and automatic checkpoints remain future milestones. The bare `/jscpd` overlay is tracked
separately in
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
