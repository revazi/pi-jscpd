# pi-jscpd

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/revazi/pi-jscpd.svg)](https://github.com/revazi/pi-jscpd/issues)
[![status: automatic checks](https://img.shields.io/badge/status-automatic%20checks-green.svg)](#project-status)

> A Pi-native, polyglot duplication guardrail powered by jscpd.

`pi-jscpd` is a quiet advisory layer for the Pi coding agent. It detects
duplicate code introduced during an agent session, points Pi to the existing
implementation, and supports the normal inspect → refactor → test → rescan
flow.

## Project status

**Explicit scans, quiet automatic session-delta checks, the responsive overview, actionable finding presentation, and ephemeral pre/post-refactor verification are implemented.**

Automatic changed checks run after Pi's `agent_settled` event. The bounded
scheduler tracks mutation generations, coalesces pending work, and lets explicit
scans supersede only scheduler-owned work. Clean and failed checks update only a
compact footer/status state. An actionable delta adds one bounded custom message
for the next model context with `triggerTurn: false`; it includes at most five
prioritized findings and is acknowledged only after delivery. When conservative
signals show that Pi Fallow or project scripts already run duplication analysis,
automatic jscpd changed checks remain on demand and one informational notice
explains explicit/scoped choices. See the
[automatic advisory checkpoint decision](docs/automatic-checkpoint.md) and
[Fallow coexistence policy](docs/fallow-coexistence.md).

Bare `/jscpd` opens one responsive TUI overview with explicit changed/project
scan actions, findings and detail views, literal filtering, status controls, and
help. It starts with status only and never treats opening the overlay as a scan.
Loading, cancellation, narrow terminals, command-context shutdown, and component
cleanup remain bounded. RPC receives one notification fallback; JSON and print
modes receive the same plain status fallback on stderr.

The extension registers `/jscpd scan`, `/jscpd changed`, `/jscpd status`, and the
`jscpd_run` agent tool from one typed command registry. On the first explicit
scan, changed check, or status request in a project/session,
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
fragments, and include aggregate statistics plus both locations. The overlay,
slash command, and model-facing results share bounded location, line-span, size,
format, and changed/existing labels. Full-project results explicitly leave the
new/existing relation unknown. Advisory guidance asks users to inspect first,
refactor and test only when appropriate, or retain/configure an intentional
jscpd exclusion through the normal agent flow. Missing or incompatible binaries,
unsafe or unsupported paths, process failures, missing or
invalid reports, timeout, cancellation, and cleanup uncertainty fail open with
bounded diagnostics. Overlay actions route through the same executor and
scheduler instead of launching child processes directly.

Trusted project and local extension settings are now loaded strictly at session
start. They can disable scanning, set the bounded per-run timeout, and cap
presented findings. Invalid sources are ignored atomically with a concise
warning; untrusted projects are never inspected for extension configuration.
`/jscpd status` reports the effective source and mode, the bounded binary name
and version state, and the session's latest clean, findings, cancelled, failed,
or never-run check without exposing child output or environment content.
`/jscpd off` disables scanning for the current session; status and help remain
available, and `/jscpd on` restores scanning without changing project files.
The session override, bounded last-check summary, changed-file set, and bounded
acknowledgements are saved as versioned Pi custom entries outside model context.
Reload, resume, fork, and `/tree` restore the latest valid snapshot on the active
branch; a new branch without one resets to trusted configuration, a never-run
check, no changed files, and no acknowledgements. Versions 1 and 2 migrate
compatibly with an empty acknowledgement set.

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
`/jscpd changed` and `jscpd_run { command: "changed" }` run a current bounded
full-project scan and compare it with the accepted ephemeral pre-session
baseline. They return only net-new clone groups that involve a path attributed
to a successful built-in `write` or `edit`. Each location is labelled either
“new in this session” for a tracked changed file or “existing match” for the
other current location. Already-existing repository duplication and net-new
groups unrelated to tracked files are omitted. Incomplete identity evidence is
reported conservatively instead of being guessed.

A finding is acknowledged when it is actually displayed; findings omitted by
the configured display cap remain unacknowledged. Repeating the changed check
without another relevant mutation does not repeat it. A materially changed
block receives a different content-aware identity. A successful scan that no
longer contains an acknowledged group drops that acknowledgement, and a verified
built-in mutation of either occurrence invalidates it conservatively, so removed
then reintroduced findings can surface again.

Acknowledgements are bounded and stored only in Pi's active-branch custom
session state. Session-state version 3 adds an explicit internal clone-identity
version marker plus opaque fingerprints and their two project-relative paths;
versions 1 and 2 migrate with an empty acknowledgement set. This is an internal
migration boundary, not a public jscpd identifier or portable baseline format.
The accepted report and source-byte evidence remain ephemeral. Reload, resume,
fork, and tree navigation therefore preserve suppression only on the branch
that surfaced the finding. Missing, partial, cancelled, timed-out, or failed
baselines and scans fail open with bounded diagnostics and do not acknowledge
anything.

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
  "maxFindings": 10,
  "fallowCoexistence": "auto"
}
```

`timeoutMs` is an integer from 100 through 300000. `maxFindings` is an integer
from 1 through 100. `fallowCoexistence` accepts `auto`, `on-demand`, or `allow`.
The default `auto` policy suppresses only automatic jscpd changed checks after a
high-confidence Fallow duplication signal; ambiguous evidence does not suppress.
`on-demand` makes that choice explicit, while `allow` opts into both automatic
analyzers. Explicit and scoped jscpd requests remain available in every
coexistence mode. These settings govern extension behavior only; clone modes,
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
retained. JSON does not expose SARIF's `jscpdCloneHash/v1`; the internal stable
identity therefore hashes the source bytes at both retained occurrence spans
without presenting that digest as jscpd evidence. Unknown additive fields are
accepted where they cannot change the required contract. Malformed variants, inconsistent clone counts, unsafe or
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

After a future npm release, the minimal installation path will be:

```text
pi install npm:pi-jscpd
pi
```

The extension will use an existing `jscpd` or `cpd` v5 binary on `PATH`. It will
not download or install a binary. If neither command is available, Pi continues
normally; explicit scan and status requests explain the missing prerequisite.

The implemented public surface is deliberately small:

```text
/jscpd                       open the responsive overview; do not scan implicitly
/jscpd scan                  scan the project
/jscpd scan src "path here"  scan existing in-project files or directories
/jscpd changed               show unacknowledged new session duplication
/jscpd status                show binary, config, mode, and last-check state
/jscpd off                   disable scanning for this session
/jscpd on                    re-enable scanning for this session
/jscpd help                  show generated command help
jscpd_run                    use the same scan, changed, status, control, and help commands
```

The tool schema accepts the generated registry command enum, optional bounded
scan-scope strings, and no unknown fields. `changed`, status, controls, and help
accept no arguments. Slash-command quotes group paths with spaces. Scope tokens
that look like options cannot override the extension-owned reporter or output
path; they are accepted only when they identify a real in-project file or
directory and are passed after `--`. Neither surface constructs a shell command.

The `off` and `on` controls are session-only overrides. While off, explicit scan
requests return a consistent disabled diagnostic instead of starting a process;
`status`, `help`, and `on` remain available. Pi custom entries preserve the
latest override, bounded last-check state, canonical changed-file set, and
version-marked acknowledgements on each conversation branch, so reload, resume,
fork, and tree navigation reconstruct state from the active branch only. A new
branch with no snapshot uses current trusted configuration and empty tracking
state. Version 1 and 2 snapshots migrate valid prior fields with no
acknowledgements. Capability caches, child processes, temporary reports,
ephemeral baselines, and loaded configuration are never restored: they are
invalidated or cleaned up, and configuration is loaded again under the current
trust decision.

The bare `/jscpd` command implements the accepted
[`/jscpd` overlay interaction contract](docs/overlay-interaction.md). The first
shell provides combined overview, findings/detail views, controls, responsive
bounds, cancellation, cleanup, and non-TUI fallback without automatic source
changes.

## Verification and intentional duplication

Every successful explicit `/jscpd scan`, or `/jscpd changed` that performs a
scan, records one ephemeral content-aware checkpoint for that scan kind and
exact scope. After inspecting a
finding, make any approved edits and run relevant project tests through Pi's
ordinary workflow, then rerun the same command or use `r` in the overlay. The
next result distinguishes duplicate blocks removed, remaining, and newly
created; ambiguous identity comparisons are reported instead of guessed. Each
successful comparison becomes the next checkpoint.

Verification state is bounded to one project-scan scope and one changed-check
scope. It is never persisted, does not affect jscpd's statistics, and resets on
session, branch, tree, reload, or shutdown transitions. A changed target scope
starts a fresh checkpoint rather than claiming unrelated blocks were removed.
If content identities are incomplete, the scan result remains available but the
verification comparison fails open.

Intentional duplication is not a defect by definition. Keep it when appropriate,
or update the repository's normal jscpd policy—such as `.jscpd.json` or its
package-level jscpd settings—using jscpd's supported ignore/exclusion controls.
Use the same policy for local and CI scans. The extension never writes that
configuration, edits source, or runs project tests itself.

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
JavaScript/TypeScript analysis such as dead code, dependencies, complexity,
architecture, and security-candidate checks. This project is narrower: a
Pi-native duplication workflow using jscpd's polyglot and embedded-format
coverage plus session attribution and verification.

The default coexistence detector recognizes an active `fallow_run` tool paired
with project Fallow evidence, readable strict-JSON Fallow duplication
configuration, or direct package scripts for Fallow duplication-bearing
commands. An explicit Fallow duplication disable
wins. Dependencies alone, unsupported JSONC/TOML, unreadable signals, and
untrusted project files remain ambiguous and never suppress automatic checks.
Detected overlap is explained once without changing either tool. Use on-demand
`/jscpd changed`, scoped `/jscpd scan <target>`, or explicitly set
`fallowCoexistence` to `allow`. The complete bounded signal contract and
limitations are documented in the
[Fallow coexistence policy](docs/fallow-coexistence.md).

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
│   ├── automatic.ts       fail-open automatic changed-check execution
│   ├── fallow.ts          conservative Fallow overlap/coexistence policy
│   ├── scheduler.ts       coalesced automatic and explicit scan ownership
│   ├── finding-presentation.ts  shared bounded finding details and guidance
│   ├── verification.ts    ephemeral pre/post-refactor clone comparison
│   ├── overlay.ts         responsive bare-command TUI and non-TUI fallback
│   ├── session-state.ts   strict active-branch state snapshots and restoration
│   └── presentation.ts    bounded model and terminal summaries
├── test/                  package and command-contract tests
├── docs/
│   ├── automatic-checkpoint.md  accepted M4 lifecycle decision
│   ├── fallow-coexistence.md    supported overlap signals and choices
│   └── overlay-interaction.md   accepted bare-command overlay contract
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
restoration, conservative changed-file tracking, ephemeral initial baseline
capture, content-aware comparison, changed-only reporting, and acknowledgement
tracking are in place. Tests use deterministic fakes and do not download
anything; a real installed v5 binary can be used for a local scan smoke. The
automatic checkpoint process model, bounded scheduler, fail-open execution,
quiet status feedback, and bounded actionable delta delivery are implemented.
The bare `/jscpd` interaction contract, responsive shell, actionable finding
presentation, and pre/post-refactor verification workflow are implemented.
Development continues in the
[GitHub issue tracker](https://github.com/revazi/pi-jscpd/issues).

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
