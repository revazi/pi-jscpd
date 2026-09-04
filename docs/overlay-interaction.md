# `/jscpd` overlay interaction contract

Status: **implemented behavior contract; Effect migration pending**

Applies to: bare `/jscpd` only

Does not change: `/jscpd scan`, `/jscpd changed`, `/jscpd status`, session controls, or `jscpd_run`

The [Effect migration](effect-migration.md) must route overlay actions through
the extension's single managed runtime while keeping Pi TUI rendering and input
as the host adapter. It must preserve every interaction below.

## Decision summary

In Pi's TUI mode, bare `/jscpd` opens one centered responsive overlay. Its
initial view is a **combined overview**, not an implicit scan or a command
palette. It shows compact status, the current ephemeral result when one exists,
and explicit actions. The user can request a changed-files check or full-project
scan, inspect bounded findings, toggle the session mode, refresh status, or open
help. The overlay never edits source, runs project tests, or changes jscpd
configuration.

The first implementation has four views:

1. **Overview** — status, last check, changed-file count, current-result summary,
   and actions.
2. **Findings** — a bounded searchable list from the latest current overlay or
   automatic result.
3. **Finding detail** — both locations, relation labels, clone size/format,
   uncertainty, and advisory next actions.
4. **Help** — controls, state meanings, explicit command equivalents, and the
   intentional-duplication caveat.

Navigation uses one focused overlay and a view stack. It does not create stacked
child overlays.

## Entry and initial state

Bare `/jscpd` must never mean “scan now.” In TUI mode the command calls:

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "80%",
    minWidth: 32,
    maxHeight: "80%",
    margin: 1,
  },
});
```

The overlay opens immediately with a bounded loading overview while it obtains
status through the existing service. A capability probe is allowed because the
user explicitly opened the integration; no duplication scan starts until the
user chooses one.

The overview then shows:

- session mode and whether it came from configuration or a session override;
- binary readiness and version, or a short setup/recovery state;
- effective extension configuration source;
- last-check summary;
- tracked session-change count and whether the current result is fresh;
- current finding/clean summary when an ephemeral result is available; and
- the available actions.

An ephemeral result cache may retain normalized presentation data only for the
active extension runtime, project, branch scope, and mutation generation. It is
cleared on session replacement/reload and invalidated by a newer mutation or
branch navigation. Findings and source fragments are not added to persisted
session state. After restoration, the overview may show the persisted last-check
summary, but opening details requires a new current result.

## Views and actions

### Overview

The action list is ordered as follows:

1. **Check session changes** — equivalent to `/jscpd changed`; this is the
   default action when tracked changes exist and scanning is enabled.
2. **Scan project** — equivalent to `/jscpd scan` with no target arguments.
3. **View findings** — available only for a fresh cached result containing
   findings.
4. **Refresh status** — equivalent to the status service, not a duplication
   scan.
5. **Disable for session** or **Enable for session** — routes through the
   existing `off`/`on` control and changes no project file.
6. **Help**.

Arbitrary target entry is intentionally omitted from the first overlay. Users
retain `/jscpd scan <target ...>` for scoped scans; this avoids introducing a
second path parser or an ambiguous free-form field.

### Findings

The findings view uses the ordering already selected by the presentation layer.
For changed checks, pairs whose two locations changed in the session come first,
then larger pairs, then deterministic location order. Each row contains:

- ordinal and total, including a clear omitted-count indicator;
- first bounded path and line span;
- second bounded path and line span;
- `new in this session` / `existing match` labels where known; and
- line count, token count, and format.

The list never renders source fragments. It retains at most the validated
configured finding limit (maximum 100), renders only the visible viewport, and
states when the detector or display limit omitted findings.

`/` enters filter mode. Filtering is a case-insensitive literal substring match
against the two displayed paths and format. It is not a regular expression,
does not access the filesystem, and is capped at 256 Unicode code points. An
empty query restores the original deterministic order. A no-match state keeps
the filter and footer visible.

### Finding detail

The detail view repeats both bounded locations, spans, size, format, and
new/existing labels. It also states:

- “Duplication may be intentional; inspect both locations before changing
  code.”
- ambiguous or incomplete classification when applicable;
- omitted related findings when applicable; and
- the explicit rescan route.

M5.3 may add actions that **prefill** a bounded inspect/refactor or intentional-
configuration request into Pi's editor after closing the overlay. Prefill must
not submit a prompt, trigger a model turn, modify source, run tests, or write
configuration. No “refactor now,” “delete,” or automatic ignore/configure action
belongs in the overlay.

### Help

Help lists the visible keyboard controls, command equivalents, missing-binary
setup direction, session-only nature of enable/disable, and the advisory rule.
It remains bounded and does not probe or scan.

## Asynchronous state model

The shell has exactly one of these states:

| State | Rendering and available behavior |
| --- | --- |
| `loading-status` | Open immediately; show “Loading status…” and allow cancel/close. |
| `ready` | Show overview and enabled actions. |
| `running-changed` | Show “Checking session changes…” and allow cancellation. |
| `running-scan` | Show “Scanning project…” and allow cancellation. |
| `clean` | Show a short clean result; add no model message. |
| `findings` | Show count and allow Findings/detail navigation. |
| `empty` | Explain that no session-owned changed files are tracked and no scan ran. |
| `disabled` | Explain the session/config state and make Enable the primary action. |
| `unavailable` | Show missing/incompatible binary or baseline limitation and recovery action. |
| `timed-out` | Show the configured bound and allow retry. |
| `cancelled` | Confirm cancellation and return to usable overview state. |
| `failed` | Show a bounded safe reason and allow status refresh/retry. |
| `stale` | Do not present the result as current; require rescan or reopen. |

Messages reuse normalized execution results and must not expose subprocess
output, environment values, temporary paths, source fragments, or internal
fingerprints.

Only one overlay action may run at a time. While it runs, scan/toggle actions are
disabled. Status/help navigation may remain available only if it does not hide
the cancellation control.

## Cancellation, lifecycle, and ownership

Each overlay instance owns one action `AbortController`. The action still routes
through the existing scheduled executor and serialized `JscpdService`; the UI
never starts a child process directly.

- `Esc` or the configured select-cancel key during an idle view goes back one
  view; from Overview it closes the overlay.
- During loading or a scan, the first cancel requests abort and keeps the overlay
  open until the bounded operation settles, then shows `cancelled`.
- `Ctrl+C` has the same safe cancel behavior while work is active. When idle it
  closes the overlay rather than exiting Pi.
- `q` closes from an idle view. If work is active it requests cancellation and
  closes only after owned settlement.
- `dispose()` is idempotent, aborts owned work, drops late render callbacks, and
  starts no cleanup process of its own.
- Session shutdown, reload, branch navigation, or command-context cancellation
  aborts the action. Late completions cannot update another branch or project.
- A result is renderable only when its overlay instance token, project identity,
  lifecycle scope, and mutation generation remain current. Otherwise render
  `stale` or discard it if the overlay has closed.

Closing the overlay does not cancel unrelated explicit or automatic work. An
overlay scan may supersede scheduler-owned automatic work under the existing
explicit-work priority rule.

## Keyboard and accessibility contract

Use the injected `KeybindingsManager` for Pi select/navigation bindings and
`matchesKey()` only for overlay-specific letter shortcuts. Never import or
mutate global keybindings.

| Input | Behavior |
| --- | --- |
| configured up/down; `j`/`k` outside filter mode | Move selection |
| configured page up/down | Scroll one viewport |
| configured confirm; `Enter` | Activate selected row/action |
| configured cancel; `Esc` | Back, close, or cancel active work |
| `Tab` / `Shift+Tab` | Cycle Overview and Findings when Findings is available |
| `/` | Enter literal filter mode in Findings |
| `Backspace`, arrows, Home/End | Edit filter while filter mode is active |
| `r` | Rerun the current scan kind, or refresh status when no scan kind exists |
| `c` | Start changed-files check from Overview |
| `s` | Start full-project scan from Overview |
| `o` | Toggle session enable/disable from Overview |
| `?` | Open Help |
| `q` / `Ctrl+C` | Safe close/cancel as defined above |

Every action has a visible text label; color, glyphs, and punctuation are never
the only indication of selection, disabled state, error, freshness, or relation.
The selected row uses a textual `>` marker as well as theme emphasis. Help text
uses Pi key-hint utilities where a configured binding exists. The component
accepts focus through the normal `Focusable` contract and requests a render
after every state, selection, filter, or async-result change.

## Responsive and bounded rendering

Implementation must use the callback-provided theme and ANSI-aware Pi TUI
utilities (`visibleWidth`, `truncateToWidth`, and wrapping helpers). Every
rendered line must have visible width less than or equal to the supplied width.

- At 72 columns and wider, Overview may use a two-section layout; Finding detail
  may place metadata beside locations only when both remain readable.
- From 40–71 columns, use a single-column layout and wrap labels before bounded
  values.
- Below 40 columns, use a compact single-column layout: short title, one action
  or location field per line, no decorative side-by-side content, and a minimal
  footer that always retains cancel/close guidance.
- Height is capped at 80% of the terminal. Header and footer remain visible;
  content scrolls within the remaining viewport. Render no more rows than the
  current overlay viewport instead of relying on compositor truncation.
- Paths use the existing middle-ellipsis bound and receive a second display-
  width truncation at render time. Counts and omitted-state text remain visible.
- The filter is capped at 256 code points, cached findings at 100, and detail at
  one finding. No unbounded report, list, or source content enters a component.

The overlay must remain closable on a 30x10 terminal. It may reduce content to a
status line, selected action, and footer, but it must not use responsive
`visible: false` because an invisible focused modal can strand input.

## Non-TUI fallback

The command must branch on `ctx.mode`, not `ctx.hasUI`: RPC reports UI capability
but cannot render terminal components.

- **RPC:** never call `ui.custom()`. Execute the existing status operation and
  emit one non-blocking `ui.notify` request containing the bounded status plus:
  `Use /jscpd changed, /jscpd scan, /jscpd off|on, or /jscpd help.`
- **JSON and print:** never call `ui.custom()` and never start a duplication
  scan. Execute the same status operation and write the same bounded plain-text
  fallback once to stderr, preserving stdout for JSON/print output. A closed
  stderr fails open.
- **All non-TUI modes:** do not wait for input, create a component, alter model
  context, or trigger a model turn. Explicit subcommands and `jscpd_run` remain
  the machine-friendly interface.

Exact fallback prefix:

```text
The /jscpd overlay requires Pi TUI mode.
<bounded /jscpd status output>
Use /jscpd changed, /jscpd scan, /jscpd off|on, or /jscpd help.
```

## Acceptance examples for M5.2–M5.3

### Wide ready overview (100x30)

```text
+ pi-jscpd ---------------------------------------------------------------+
| enabled (configuration) | jscpd 5.x ready | 3 session-changed files   |
| Last check: 2 new duplicate blocks | current                           |
|                                                                         |
| > Check session changes                                                 |
|   Scan project                                                          |
|   View 2 findings                                                       |
|   Refresh status                                                        |
|   Disable for session                                                   |
|   Help                                                                  |
|                                                                         |
| Up/Down move  Enter select  / filter  ? help  Esc close                |
+-------------------------------------------------------------------------+
```

### Narrow overview (52x16)

```text
+ pi-jscpd -------------------------------------+
| enabled | jscpd ready                         |
| 3 changed files | last: clean                 |
|                                                |
| > Check session changes                       |
|   Scan project                                |
|   Disable for session                         |
|                                                |
| Enter select | ? help | Esc close             |
+------------------------------------------------+
```

### Missing binary

```text
pi-jscpd | unavailable
jscpd v5 was not found (checked jscpd, then cpd).
The bundled analyzer is unavailable. Reinstall pi-jscpd.
> Refresh status
  Help
No scan started.
```

### Finding detail

```text
Duplicate block 1 of 2 | new in this session
src/new.ts:12-28
matches existing implementation
src/existing.ts:44-60
17 lines | 91 tokens | typescript
Duplication may be intentional; inspect both locations before changing code.
Enter back | r rescan | ? help | Esc back
```

### Component and smoke-test matrix

M5.2 and M5.3 tests must cover:

- bare command opens exactly one overlay only in `mode === "tui"`;
- RPC notification fallback and JSON/print stderr fallback start no scan;
- loading, clean, empty, findings, disabled, missing, incompatible, timeout,
  cancellation, failure, and stale states;
- 100x30, 52x16, and 30x10 rendering with every line within visible width and
  header/footer retained;
- configured navigation keys plus letter shortcuts, filter editing/no-match,
  view-stack back behavior, focus, and theme invalidation;
- one active action, repeated-key suppression, cancellation propagation, late
  completion discard, idempotent `dispose()`, and no timer/process leak;
- both finding locations, relation labels, size, format, omitted count,
  ambiguity text, and no source fragments/fingerprints;
- no source mutation or configuration write from any overlay action; and
- package/RPC smoke proving command discovery and non-TUI completion without a
  hang.

## Deferred from the first overlay

- source preview or syntax-highlighted fragments;
- arbitrary scan-target input;
- mouse interaction;
- clone-family graphs;
- automatic refactoring, test execution, ignore-rule writes, or configuration
  editing; and
- persisted finding-detail caches.
