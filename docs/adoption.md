# First scans and safe finding review

[Install and run your first scan](../README.md#install), then choose the smallest
useful scope below. These examples describe expected workflows, not transcripts
or claims about your repository. All scans are read-only and advisory.

## Clean scan: start with one scope

```text
/jscpd scan src
```

If jscpd finds no duplicate blocks under `src` with the current detection policy,
the explicit result is clean. This does **not** prove the entire repository is
free of duplication: matches outside that target, ignored files, unsupported
formats, and blocks below the configured thresholds are outside the result.
A failure or timeout is not a clean scan; `/jscpd status` gives bounded diagnostics
and Pi can continue normally.

To compare two areas, include both:

```text
/jscpd scan src lib
```

Replace the targets with existing in-project paths. Quote a path containing spaces,
for example `/jscpd scan "sample app"`. Scoped scans compare only their targets;
`/jscpd changed` instead compares the full project and filters by tracked Pi edits.

## New in this session: distinguish new work from existing debt

Suppose `src/orders.py` already contains a block when a fresh Pi session begins.
Later, Pi's built-in `write` or `edit` adds matching code in `src/summary.py`.
With a usable baseline and an identifiable new pair, the changed check can show:

- `src/summary.py`: **new in this session**;
- `src/orders.py`: **existing match**;
- the duplicate block's line spans, size, and format for inspection.

```text
/jscpd changed
```

Automatic checks normally surface actionable new findings after Pi settles,
without starting another model turn. If the finding was already surfaced, an
explicit changed check may omit it because it is acknowledged—not because it was
fixed. Existing repository duplication is also omitted from changed-only findings.
Use `/jscpd scan src` (or a project scan for matches outside `src`) to inspect
current duplication regardless of acknowledgement.

A full or scoped `scan` labels **current locations**; it does not determine which
side is new. A missing/partial baseline or ambiguous identity is not proof of a
new duplicate. Shell commands, manual edits, and custom mutation tools are not
tracked as Pi-owned changes; use an explicit `scan` for those changes.
See [session checks](../README.md#how-session-checks-work) for the lifecycle and
[Fallow coexistence](fallow-coexistence.md) when automatic checks are on demand.

## Intentional duplication: use normal jscpd policy

A duplicate test fixture may deliberately preserve an independent example or a
protocol boundary. Inspect both locations and ask whether they should evolve
together. Keeping the duplicate can be the correct outcome; no exclusion is
required merely to dismiss an advisory finding.

If the maintainer decides a fixture directory should be outside detection,
merge a narrow exclusion into the repository's existing `.jscpd.json` policy:

```json
{
  "ignore": ["**/test/fixtures/**"]
}
```

This is an example for a deliberately excluded fixture directory, not a
recommendation to ignore all tests. Preserve other ignore entries and settings;
do not replace an existing configuration with this snippet. Repositories using
package-level jscpd settings should keep their policy there instead. Detection
policy does not belong in `.pi/jscpd-guardrail.json`.

Review the policy change through the normal agent/code-review flow, then rerun
the same scan scope. Fewer findings after an exclusion mean less code was analyzed,
not that source duplication was removed. Start a fresh Pi session (rather than
resuming previously tracked edits) before a session-delta comparison under changed
detection policy so its baseline uses the same policy.

## Review without automatic refactoring

1. Open `/jscpd`, choose a scan action, then press Enter on a finding to expand
   both locations. Opening the overview itself does not scan.
2. Read both blocks and surrounding behavior before deciding whether to share
   code, retain independent implementations, or propose a narrow exclusion.
3. Optionally press `e` to load the current/selected finding into Pi's editor.
   Review the prompt before submitting; the handoff does not submit or edit code.
4. Only make a justified change through your normal agent flow. Run relevant
   project tests, then repeat the same scan scope. Verification can report removed,
   remaining, or newly created duplicate blocks; it does not prove behavior is
   correct. Respect omitted and safely unclassified counts.

[Full overlay controls](overlay-interaction.md#keyboard-and-accessibility-contract)
and the on-demand `/skill:jscpd` provide the detailed workflow without adding
routine guidance to every model turn. `/jscpd off` disables both explicit and
automatic scans for this session; `/jscpd on` restores scanning. Neither edits
configuration, enforces a threshold on Pi writes, or refactors code.

## Visual provenance

The [README image](images/jscpd-findings.png) comes from the unmodified source
extension at `fa7872d`, loaded by real Pi 0.85.1 with Node 24.12.0 and bundled
jscpd 5.1.2 on macOS arm64. An isolated, disposable project contained two generated
Python files; no private repository was used. The real analyzer found one pair
(14 lines, 89 tokens). Both files existed before Pi started, so this image shows
**current locations**, not newly introduced duplication.

Capture sequence: regular TUI at 80 columns by 32 rows, `/jscpd`, `s` for project
scan, Enter to expand the finding. The terminal cells were rasterized in monochrome
and cropped to the overlay. No text, counts, labels, or results were substituted;
compact-row truncation and wrapping are the actual TUI output. The image is
1192×652 pixels and is intended to remain readable when scaled to README width.

Text alternative: one Python duplicate block links `src/orders.py:1-14` and
`src/summary.py:1-14`. Detail records a verification checkpoint, explains that a
project scan cannot decide which location is new, and asks the user to inspect
both locations and surrounding behavior before changing code.

The capture run used offline mode, isolated home/agent/temp directories, no
session persistence, no project trust approval, no resource discovery, and no
provider or built-in tool calls. Pi quit normally; no analyzer reports remained.
Only the cropped sanitized PNG and this aggregate provenance are retained—not
raw terminal output, source fixtures, reports, host/account data, or private paths.
This adoption visual is separate from the incomplete [#99 validation
matrix](m8-validation.md); it makes no additional performance or usability claim.
