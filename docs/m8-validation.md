# M8 real-project validation

Status: **partial** — [issue #99](https://github.com/revazi/pi-jscpd/issues/99)
remains open. These observations do not activate feature candidates #103–#106.

## Scope and privacy

Measurements used the Pi 0.85.1 / Node 24.12.0 / jscpd 5.1.2 development
fixtures on macOS arm64. Project B is a user-approved working tree with an active
refactor; its private paths, source, branch name, and raw reports are not retained
here. Both measured repositories fall in the 100–999 analyzed-source bucket.
Project B is in the 10,000–49,999 analyzed-line bucket, not a large-repository
stress test. It includes JavaScript, Python, and Bash according to the analyzer.

No original source or configuration was changed. Pi runs used isolated home,
agent, and temporary directories, offline mode, no session persistence, no
project trust approval, and only explicitly loaded measurement resources. No
provider calls were made. Analyzer reports existed only in owned temporary
workspaces; no raw reports or terminal captures are retained.

## Observed results

### Preliminary CLI measurements

Three sequential processes per scope; approximate wall times include process
startup and bounded Python wait overhead, but exclude report decoding/cleanup.
Normal ignore rules were retained. Project A is the public pi-jscpd checkout at
`801f27c`, using its `.jscpd.json`. Project B had no jscpd configuration or local
analyzer; it used the pinned analyzer from the extension checkout and defaults.

| Project / scope | First / later runs (ms) | Clone pairs per run |
| --- | --- | --- |
| A, full project | 184 / 129 / 130 | 48 |
| A, source directory | 73 / 74 / 73 | 1 |
| B, full project | 179 / 175 / 176 | 58 |
| B, Python implementation | 70 / 74 / 72 | 15 |
| B, JavaScript extensions | 75 / 76 / 72 | 0 |

Counts were stable within each scope. All temporary report directories were
removed. A scoped scan omits matches outside its target and is not equivalent
to changed-only full-project comparison.

### Real Pi runtime, project B

A temporary instrumentation extension composed the production capability,
analyzer, and baseline services through `registerJscpdExtension`'s service seam.
An Effect tap measured baseline start to completion, without replacing analyzer
results or bypassing normalization. A local RPC command called the registered
`jscpd_run.execute` callback; this is a real host/service measurement, not a
model-selected tool call or an automatic checkpoint.

| Operation | Observations |
| --- | --- |
| Baseline | Accepted in 219, 214, 226 ms across three fresh Pi processes |
| Full scan, session 1 | 161, 163, 174 ms |
| Full scan, session 2 | 149, 157, 170 ms |
| Full scan, session 3 | 155, 172, 170 ms |
| Full-scan findings | 58 analyzer pairs, 10 surfaced, 48 omitted in every run |
| JavaScript scoped scan | Clean in 51, 46, 49 ms |
| Changed without tracked mutations | Clean, zero surfaced/omitted, approximately 1 ms |
| Cancellation requested at 50 ms | Returned `scan-cancelled` at 56, 57, 58 ms from invocation |
| Coexistence status | Ambiguous evidence; automatic checks allowed |
| Diagnostics | Zero extension errors, provider turns, or stderr output |
| Cleanup | Zero report directories remaining after each Pi shutdown |

Baseline timings exclude Pi startup before baseline invocation. Scan callback
wall times include application normalization and finalization. The cancellation
timer was scheduled for 50 ms; actual timer delivery was not separately recorded,
so 6–8 ms is **not** a precise cancellation-latency measurement. Direct process-tree
enumeration was not collected for these real-analyzer runs. No-mutation changed
results do not prove clean automatic-checkpoint silence.

### Real TUI findings smoke, project B

The uninstrumented source extension was loaded into the real Pi CLI in regular
TUI mode in isolated tmux sessions at 50, 80, and 120 columns (32 rows). At each
width, an explicit project scan displayed the 58-result findings view. Down/Enter,
search, a Python filter, clear-filter/PageDown, and close inputs changed the
rendered frame; no report directories remained after shutdown.

This is a keyboard-response smoke, not human usability acceptance. Captured
frames were no wider than the terminal, but tmux capture clipping alone cannot
prove component width correctness; component bounds are separately checked by
[package certification](compatibility.md). An initial probe expected the word
“duplicate” at every width; the wider layout instead displayed “findings”. The
probe predicate was corrected. That was a measurement-script error, not an
extension defect. Fullscreen behavior, selection/editor handoff, and actual
compact/expanded transcript interaction still need acceptance.

## Reproduction procedure

1. Obtain explicit approval for the target. Record only a repository alias,
   size bucket, format mix, versions, and whether the working tree is dirty.
   Do not alter its existing detection policy.
2. Run the pinned local analyzer with the target as cwd and argument array
   `[scope, "--reporters", "json", "--output", temporaryDirectory,
   "--silent", "--no-colors", "--no-tips"]`. For project A explicitly select
   `.jscpd.json`. Own the process group, impose a 30-second deadline, discard
   stdout/stderr, decode a bounded report, keep numeric statistics only, and
   remove the temporary directory in a finalizer. Repeat each scope three times.
3. For host timings, load a local instrumentation extension into the exact Pi
   fixture. Supply production capability/analyzer/baseline services, wrap
   baseline `startEffect` with a monotonic timer and Effect tap, and call the
   captured registered tool from an explicit local command after acceptance.
   Measure status, no-mutation changed, three full scans, a JavaScript scoped
   scan, then a full scan with a signal aborted by a 50-ms timer. Preserve all
   normal production result handling. Record only status, timing, counts, and
   coexistence enums. Use three fresh Pi processes and bound each at 60 seconds.
4. Launch the uninstrumented CLI with `--offline --no-session --no-approve`,
   disable extension/skill/prompt/theme/context discovery, and load only the
   local jscpd extension with `-e`. Set isolated home/agent/temp directories.
   In regular TUI mode at each width, open `/jscpd`, wait for readiness, press
   `s`, then exercise Down/Enter, `/`, a Python filter, Enter, `x`, PageDown,
   and `q`. Quit normally; inspect owned reports and child processes before
   removing the isolated workspace. Keep aggregate observations, not captures.
5. Never enable a real provider or automatically submit a finding handoff.
   Do not infer project trust for a child from the parent session. Mutations for
   changed-only scenarios belong only in an explicitly approved disposable copy.

## Remaining acceptance and decision

- A genuinely larger representative target is still needed.
- Real-analyzer cancellation needs exact abort-to-settlement timing and direct
  process-tree cleanup checks before it can be marked fully verified.
- Controlled timeout/failure and configured Fallow overlap need real-host
  observations; ambiguous evidence is not positive coexistence acceptance.
- Real compact/expanded transcripts, fullscreen UI, selection/handoff, and a
  changed-only mutation/clean-checkpoint scenario remain unexecuted here.
- Finding usefulness is unassessed: actionable, intentional, and uncertain
  counts are unknown. Do not label the 58 historical pairs false positives or
  new session warnings. A bounded review needs project-owner context.

Small/medium-project timings show no demonstrated performance problem. They do
not establish large-project latency, attribution quality, or navigation ease.
Keep #99 open and defer all candidate feature decisions. File a separate minimal
reproduction issue if further validation establishes an actual product defect.
