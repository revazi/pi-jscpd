# Fallow coexistence policy

Status: implemented for M6.1  
Applies to: automatic `pi-jscpd` changed checks only

## Purpose

Fallow and jscpd both detect duplication. When Pi Fallow or a project Fallow
command already runs duplication analysis, two automatic warnings for the same
change are noisy. `pi-jscpd` therefore detects only a small set of conservative
signals and, on a high-confidence match, keeps its automatic changed checks on
demand. Explicit `/jscpd` commands and `jscpd_run` remain available.

No coexistence state disables Fallow, changes either analyzer's detection
semantics, edits project configuration, or changes jscpd's own ignore and format
policy.

## Configuration

`.pi/jscpd-guardrail.json` and its local override accept:

```json
{
  "fallowCoexistence": "auto"
}
```

- `auto` (default): apply conservative detection. A detected overlap suppresses
  automatic jscpd changed checks and explains the choice once. Ambiguous or
  absent evidence leaves automatic checks enabled.
- `on-demand`: explicitly suppress automatic jscpd changed checks. Explicit
  changed, project, and scoped scans remain available.
- `allow`: explicitly allow both automatic analyzers, even when Fallow is
  available.

The normal trust-gated, strict, atomic extension configuration rules apply.

## Supported signals

Under `auto`, these are treated as high confidence:

1. an active Pi tool named `fallow_run` together with project Fallow evidence
   (a config file or `fallow`/`pi-fallow` dependency), because Pi Fallow's
   default aggregate includes Fallow duplication;
2. the first supported strict-JSON Fallow config (`.fallowrc` or
   `.fallowrc.json`) contains a `duplicates` object whose `enabled` value is
   `true` or omitted; or
3. a direct `package.json` script command invokes `fallow`'s combined root,
   `dupes`, `audit`, `all`, `check-changed`, or `review` command. Commands must
   occur at a shell command-segment boundary; prose such as
   `echo fallow dupes` is not accepted.

A readable `duplicates.enabled: false` is authoritative for detection and keeps
automatic jscpd checks enabled, even when the Fallow tool or script is present.
This only observes Fallow's setting; it does not alter it.

The following evidence is deliberately ambiguous and never suppresses an
automatic check:

- an active `fallow_run` tool with no project Fallow evidence;
- a `fallow` or `pi-fallow` package dependency without an active tool or direct
  duplication command;
- a Fallow config with no `duplicates` section and no active Pi Fallow tool;
- JSONC or TOML Fallow configuration, which this adapter does not partially
  parse;
- malformed, oversized, unreadable, non-regular, or out-of-project signal
  files; and
- an untrusted project, because project-use evidence is not inspected.

Signal reads are trust-gated, no-follow, project-contained, and capped at 64
KiB. Only fixed signal identifiers enter status; file contents and absolute
paths do not.

## User-visible behavior

A detected automatic overlap emits one informational notice per Pi session:

```text
Fallow duplication analysis appears active. To avoid duplicate warnings,
automatic jscpd changed checks are on demand; no configuration was changed.
Use /jscpd changed or a scoped /jscpd scan <target>.
```

`/jscpd status` and the overlay report whether overlap is absent, ambiguous,
detected/on-demand, or explicitly configured. Pending footer state says
`jscpd: on demand (Fallow overlap)` instead of implying that an automatic check
will run.

The quiet pre-session jscpd baseline remains available so an explicit
`/jscpd changed` request can still classify session deltas. Opening the overlay
still performs status only. Automatic Fallow suppression does not acknowledge
jscpd findings or consume scheduler generations.

## Division of responsibility

- **Fallow** is the broader JavaScript/TypeScript codebase analyzer: duplication,
  dead code, complexity, architecture, security candidates, and related
  evidence in one workflow.
- **jscpd** remains the polyglot tokenization, clone-detection, format, and
  duplication-statistics authority for `pi-jscpd`.
- **pi-jscpd** adds Pi session attribution, changed-only comparisons,
  acknowledgement, verification, and a jscpd-focused overlay. It is useful on
  demand for polyglot or embedded-format coverage and for repositories whose
  existing jscpd policy is authoritative.

When both are desired, set `fallowCoexistence` to `allow`. Otherwise keep the
default detected on-demand behavior and use scoped jscpd scans where its
polyglot coverage adds value.

## Known limitations

Detection intentionally does not inspect arbitrary CI YAML, recursively resolve
npm scripts, infer globally installed CLI binaries, parse shell expansions, or
interpret JSONC/TOML. These omissions avoid false positives. Users can select
`on-demand` or `allow` explicitly when unsupported project policy is known.
