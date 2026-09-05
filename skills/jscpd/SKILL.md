---
name: jscpd
description: Pi-native polyglot duplicate-code analysis powered by jscpd v5. Use when asked to find duplicate blocks, check whether current-session edits duplicate existing code, scan specific project paths for duplication, interpret jscpd findings, or verify duplication after a refactor.
license: MIT
compatibility: Requires the pi-jscpd extension and its jscpd_run tool.
metadata:
  author: Revaz Zakalashvili
  version: 1.0.0
---

# jscpd duplication guardrail

Use `pi-jscpd` for deterministic duplicate-code analysis across jscpd-supported
languages and embedded formats. jscpd remains authoritative for tokenization,
clone detection, configuration, supported formats, and statistics.

## When to use

- Check whether code changed in the current Pi session duplicates existing code.
- Scan the project or specific in-project files/directories for duplicate blocks.
- Inspect both sides of a reported match before a refactor.
- Verify whether a previously reported duplicate was removed, remains, or was
  replaced by another duplicate.
- Explain analyzer readiness, configuration source, or the previous check state.

Do not use this skill as a general dead-code, dependency, complexity, lint, or
security analyzer. Do not treat every duplicate as a defect.

## Preferred interface

Prefer the `jscpd_run` tool when it is available. Do not invoke `npx`, install an
analyzer, download anything, or bypass the extension's bounded process and
report handling.

| Intent | Tool call |
| --- | --- |
| Check tracked Pi edits against the session baseline | `{ "command": "changed" }` |
| Scan the current project | `{ "command": "scan" }` |
| Scan selected in-project paths | `{ "command": "scan", "args": ["src", "test"] }` |
| Check readiness and the last result | `{ "command": "status" }` |
| Show supported operations | `{ "command": "help" }` |

Use `changed` only when Pi's built-in write/edit tracking represents the relevant
changes. If files were modified manually, by shell commands, by another tool, or
before the session baseline, use `scan` with the narrowest useful target.

The interactive `/jscpd` command is for the human-facing overview and findings
navigator. Do not attempt to operate its TUI on the user's behalf.

## Finding workflow

1. Run the narrowest appropriate `changed` or `scan` operation.
2. Report both locations, line spans, line/token size, format, and whether a
   location is `new in this session`, an `existing match`, or simply a current
   project location.
3. Inspect both locations and surrounding behavior with ordinary read tools.
4. Decide whether the duplication represents behavior that should stay
   synchronized or intentional separation across tests, generated boundaries,
   protocols, or independently owned domains.
5. Propose changes through the normal agent workflow. Never refactor, delete, or
   modify ignore/configuration policy merely because a duplicate exists.
6. After user-approved edits and relevant tests, rerun the same scan scope to
   verify the result.

Treat omitted or ambiguous findings conservatively. A display limit does not
mean additional jscpd findings are clean, and an unavailable classification must
not be presented as newly introduced duplication.

## Configuration and coexistence

Respect the repository's normal jscpd configuration, including `.jscpd.json`,
package-level settings, ignore rules, thresholds, formats, and modes. For
intentional duplication, recommend a normal jscpd exclusion only after verifying
that retaining the duplicate is deliberate; never write configuration
automatically.

When status reports that Fallow duplication overlap moved automatic jscpd checks
to on-demand mode, avoid running both duplication analyzers for the same scope
unless the user explicitly requests comparison. Explicit jscpd scans remain
available for polyglot or jscpd-specific coverage.

## Safety rules

- Advisory only: findings do not authorize source changes.
- Never expose source fragments, raw analyzer output, temporary report paths,
  environment values, or internal fingerprints.
- Never construct shell command strings from paths.
- Do not reinterpret or replace deterministic jscpd results with an LLM guess.
- If the analyzer is missing, incompatible, timed out, cancelled, or returns an
  invalid report, explain the bounded failure and fail open.
