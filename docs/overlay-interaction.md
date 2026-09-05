# `/jscpd` overlay interaction contract

Status: **implemented with managed-runtime action execution**

Applies to: bare `/jscpd` only

Does not change: `/jscpd scan`, `/jscpd changed`, `/jscpd status`, session controls, or `jscpd_run`

Overlay actions route through the extension's single managed runtime while Pi TUI
rendering and input remain the host adapter. The implementation preserves every
interaction below.

## Decision summary

In Pi's TUI mode, bare `/jscpd` opens one centered responsive overlay. Its
initial view is a **combined overview**, not an implicit scan or a command
palette. It shows compact status, the current ephemeral result when one exists,
and explicit actions. The user can request a changed-files check or full-project
scan, inspect bounded findings, toggle the session mode, refresh status, or open
help. The overlay never edits source, runs project tests, or changes jscpd
configuration.

The interface has three views:

1. **Overview** — status, last check, changed-file count, current-result summary,
   and explicit actions.
2. **Findings navigator** — a bounded searchable list with inline expansion,
   multi-selection, result counts, and a safe editor-prompt handoff.
3. **Help** — controls, state meanings, explicit command equivalents, and the
   intentional-duplication caveat.

The visual and keyboard model follows Pi Fallow's established findings navigator:
a branded frame, compact status/count pills, selected-row background plus marker,
inline details, explicit earlier/later indicators, and visible controls. Navigation
uses one focused overlay and never creates stacked child overlays.

## Entry and initial state

Bare `/jscpd` must never mean “scan now.” In TUI mode the command calls:

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "90%",
    minWidth: 50,
    maxHeight: "95%",
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

An ephemeral result cache may retain up to 100 normalized findings only for the
active extension runtime, project, branch scope, and mutation generation. This
TUI-only retention is independent of `maxFindings`: model/tool messages, explicit
subcommand output, acknowledgement writes, and persisted state remain capped by
the configured limit. The cache is cleared on session replacement/reload and
invalidated by a newer mutation or branch navigation. Findings and source
fragments are not added to persisted session state. After restoration, the
overview may show the persisted last-check summary, but opening details requires
a new current result.

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

### Findings navigator

The findings view uses the ordering already selected by the presentation layer.
For changed checks, pairs whose two locations changed in the session come first,
then larger pairs, then deterministic location order. Each compact row identifies
both bounded paths and line spans plus line count, token count, and format.
`N`, `E`, and `C` markers mean `new in this session`, `existing match`, and
`current location`; inline expansion always spells those labels out.

The navigator initially reveals 10 retained findings. **Load next 10 / L**
reveals another page without rescanning, and moving down or paging past the last
revealed row automatically reveals the next page. Search and “all shown”
selection operate on revealed findings; loading another page extends that set.

The header and result context distinguish filtered, shown, retained, total,
overlay-cache omissions, and safely unclassified counts. The viewport shows
explicit earlier/later indicators. The selected row uses both a `❯` marker and
Pi's selected background. Below 64 columns, each finding becomes a three-line row
so both locations remain readable rather than disappearing behind truncation.

Enter, Space, Right, or `l` expands the current finding inline. Left or `h`
collapses it. Expanded content repeats both locations, relation labels, size,
format, verification state, omission/ambiguity context, and advisory next steps.
The list never renders source fragments or internal fingerprints and retains at
most 100 validated findings.

`/` enters search mode. Search is a case-insensitive literal substring match
against the two displayed paths and format. It is not a regular expression,
does not access the filesystem, and is capped at 256 Unicode code points. Enter
accepts the query, Esc restores the query that existed before editing, Ctrl+U
clears it, and `x` clears an applied query. An empty query restores deterministic
order. A no-match state keeps search and close controls visible.

`s` or Tab marks the current finding, `A` toggles all shown findings, and `c`
clears selection. `e` or `a` closes the overlay and returns a compact prompt for
the selected findings—or the current finding when none are marked. At most 20
findings and 12,000 Unicode code points enter that prompt. Only after
`ui.custom()` has returned does the launcher call `setEditorText()` and notify
the user. It never submits the editor, triggers a model turn, mutates source,
runs tests, or writes configuration. No “refactor now,” “delete,” or automatic
ignore/configure action belongs in the overlay.

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
| configured up/down; `j`/`k` outside search mode | Move selection |
| configured page up/down; Home/End | Scroll one viewport or jump to a boundary |
| configured confirm; Enter, Space, Right, `l` | Activate an action or expand/collapse a finding |
| Left / `h` | Collapse the current finding |
| configured cancel; `Esc` | Cancel search/work, go back, or close |
| `Tab` | Open Findings from Overview; mark/unmark the current finding in Findings |
| `Shift+Tab` | Return to Overview from Findings or Help |
| `/` | Enter literal search mode in Findings |
| `Backspace`, arrows, Home/End, `Ctrl+U` | Edit or clear search while search mode is active |
| `x` | Clear the applied finding search |
| `L` | Reveal the next 10 retained findings without rescanning |
| `s` / Tab, `A`, `c` | Mark current, toggle all shown, or clear selected findings |
| `e` / `a` | Close and load a bounded finding prompt into Pi's editor |
| `r` | Rerun the current scan kind, or refresh status when no scan kind exists |
| `c` | Start changed-files check from Overview |
| `s` | Start full-project scan from Overview |
| `o` | Toggle session enable/disable from Overview |
| `?` | Open Help |
| `q` / `Ctrl+C` | Safe close/cancel as defined above |

Every action has a visible text label; color, glyphs, and punctuation are never
the only indication of selection, disabled state, error, freshness, or relation.
The selected row uses a textual `❯` marker plus Pi's selected background. The
component accepts focus through the normal `Focusable` contract, propagates it
to the search input, and requests a render after every state, selection, search,
or async-result change.

## Responsive and bounded rendering

Implementation must use the callback-provided theme and ANSI-aware Pi TUI
utilities (`visibleWidth`, `truncateToWidth`, and wrapping helpers). Every
rendered line must have visible width less than or equal to the supplied width.

- At 64 columns and wider, findings use one compact row with independently
  middle-truncated locations and retained size/format metadata.
- Below 64 columns, each finding uses three rows so both locations remain
  identifiable.
- Below 40 columns, use a compact single-column layout: short title, one action
  or location field per line, no decorative side-by-side content, and a minimal
  footer that always retains cancel/close guidance.
- Height is capped at 95% of the terminal. Header and footer remain visible;
  content scrolls within the remaining viewport. Render no more rows than the
  current overlay viewport instead of relying on compositor truncation.
- Paths use the existing middle-ellipsis bound and receive a second display-
  width truncation at render time. Counts and omitted-state text remain visible.
- Search is capped at 256 code points, findings reveal in pages of 10, the
  overlay cache is capped at 100, inline detail at one finding, and prompt
  handoff at 20 findings/12,000 code points. No unbounded report, list, or source
  content enters a component.

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

## Acceptance examples

### Ready overview

```text
╭ ✦ pi-jscpd · enabled ─────────────────────────────────────────╮
│ ✓ enabled (configuration)   jscpd 5.1.2 bundled              │
│ Configuration built-in defaults · 3 session-changed files    │
│ Last check 2 duplicate blocks                                │
│                                                              │
│ ❯ ◆ Check session changes · new blocks in tracked edits      │
│   ◇ Scan project · all current duplicate blocks              │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ navigate · Enter select · c changes · s scan · ? help     │
╰──────────────────────────────────────────────────────────────╯
```

### Findings navigator

```text
╭ ✦ pi-jscpd · 10/48 findings ─────────────────────────────────╮
│ 10 shown   48 retained   48 total                            │
│ Load next 10 / L · 38 cached findings remain                │
│ ❯ ☐ ▸ N src/new.ts:12-28 ↔ E src/old.ts:44-60 · 17L/91T ts  │
│   ☑ ▸ C lib/a.py:3-10 ↔ C lib/b.py:20-27 · 8L/42T python     │
├──────────────────────────────────────────────────────────────┤
│ 1 selected · ↑↓ navigate · L next 10 · Enter expand · e load│
╰──────────────────────────────────────────────────────────────╯
```

### Component and smoke-test matrix

Tests cover:

- bare command opens exactly one overlay only in `mode === "tui"`;
- RPC notification fallback and JSON/print stderr fallback start no scan;
- loading, clean, empty, findings, disabled, missing, incompatible, timeout,
  cancellation, failure, and stale states;
- 100x30, 52x16, and 30x10 rendering with every line within visible width and
  header/footer retained;
- configured navigation plus expand/collapse, search editing/cancellation,
  filtering/no-match, scrolling, selection, and view back behavior;
- one active action, repeated-key suppression, cancellation propagation, late
  completion discard, idempotent `dispose()`, and no timer/process leak;
- both finding locations, relation labels, size, format,
  filtered/shown/retained/total counts, 10-item manual and automatic reveal,
  cache omissions, ambiguity, and no source fragments/fingerprints;
- bounded prompt handoff only after overlay close, without submit or mutation;
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
