# 📋 M8 real-project validation

Status: **complete for the local milestone decision** — [issue #99](https://github.com/revazi/pi-jscpd/issues/99).
These observations do not activate feature candidates #103–#106. Residual limits
are recorded below and do not change the decision.

## Scope and privacy

Measurements used the Pi 0.85.1 / Node 24.12.0 / jscpd 5.1.2 development
fixtures on macOS arm64. Project B is a user-approved working tree with an active
refactor; its private paths, source, branch name, and raw reports are not retained
here. Projects A and B fall in the 100–999 analyzed-source bucket. Project B is in
the 10,000–49,999 analyzed-line bucket. Public project C fills the 1,000–9,999
source and 100,000–499,999 line buckets. Project B includes JavaScript, Python,
and Bash according to the analyzer.

No original source or configuration was changed. Pi runs used isolated home,
agent, and temporary directories, offline mode, no session persistence, no
project trust approval, and only explicitly loaded measurement resources. No
remote provider was contacted. Later transcript and mutation checks used a local
scripted stream, explicitly distinguished from model-selected behavior below.
Analyzer reports existed only in owned temporary workspaces; no raw reports or
terminal captures are retained.

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
extension defect. Follow-up live transcript and handoff checks are below.

### Follow-up cancellation, failures, and cleanup: project B

Three further real scans received an AbortSignal scheduled for 80 ms after tool
invocation. Monotonic timestamps immediately before `abort()` and immediately
after the tool callback settled produced:

| Run | Actual abort delivery from invocation | Abort to settlement |
| --- | --- | --- |
| 1 | 84 ms | 6.51 ms |
| 2 | 83 ms | 7.85 ms |
| 3 | 81 ms | 3.33 ms |

Every result was `scan-cancelled`; each cancellation left zero report directories.
An external observer sampled only PID, PPID, process group, and executable-name
metadata. Across the full cancellation/failure/recovery sequence it observed 11
child PIDs in seven groups. None of those children or group members remained at
the end of the sequence, either before or after Pi shutdown. IDs and raw process
listings were discarded. Sampling does not prove the absence of an arbitrarily
short-lived unobserved descendant or establish each group's exact exit time.

An initial probe ran synchronous process enumeration inside Pi's event loop and
substantially distorted timer delivery and settlement. Those latency samples
were rejected; the accepted measurements moved observation outside Pi. They
still include normal scheduler and system-load variation, not a latency SLA.

A controlled config-service seam set the production scan timeout to 100 ms only
after baseline acceptance. The real analyzer returned `scan-timed-out` at 106 ms.
A nonexistent target returned `unsupported-path`. A subsequent JavaScript scope
scan completed cleanly. These are real-host fail-open observations with a
controlled timeout, not project-config trust acceptance. There were no extension
errors, remote provider calls, stderr output, or remaining report directories.

### Live transcripts and editor handoff: project B

A local scripted provider emitted one predetermined `jscpd_run` scan call and a
completion message. Pi executed the actual tool through its normal event pipeline
and displayed its actual result. The script performed no network I/O, read no
credentials, and made no decisions about the findings. This validates live host
rendering and dispatch, **not** LLM judgment or a production provider transport.
Only `jscpd_run` was available for the scripted action; built-in tools were off.

Regular and experimental fullscreen modes were each exercised at 50, 80, and
120 columns, with 36 rows. An instrumented result component counted its real
rendered lines without changing text or retaining output:

| Terminal width | Component width | Compact lines | Expanded lines (both modes) |
| --- | --- | --- | --- |
| 50 | 48 | 1 | 81 |
| 80 | 78 | 1 | 54 |
| 120 | 118 | 1 | 50 |

Ctrl+O expanded and collapsed the live transcript at every size. All six real
scans returned findings: 10 surfaced, 48 omitted, no tool error. In each session,
`/jscpd` project scan followed by `s` displayed a one-finding selection marker;
`e` filled the editor with the duplicate-block review prompt. The prompt was
cleared rather than submitted. Local stream-call counts remained unchanged
across the handoff, verifying that it did not start another turn. Each session
shut down normally and left zero report directories.

This is stronger than frame-change-only smoke evidence, but is still automated
keyboard acceptance rather than a human navigation/usefulness assessment.

### Controlled mutation and positive coexistence: public synthetic fixture

Two fresh temporary projects contained a generated Python implementation, not a
copy of a private repository. The same local scripted stream used Pi's real
built-in `write` tool to add a short unique note, then an identical Python copy.
No production lifecycle event or analyzer report was fabricated.

| Observation | Normal defaults | Controlled positive Fallow signal |
| --- | --- | --- |
| Unique-note checkpoint | Last check clean; zero automatic messages | Not attempted; zero automatic messages |
| Duplicate-copy checkpoint | One finding; one automatic message | Not attempted; zero automatic messages |
| Subsequent explicit changed scan | Clean: already acknowledged automatically | One finding, zero omitted |
| Coexistence | No positive signal supplied | Detected; automatic checks disabled |

For the positive case, the fixture had `.fallowrc.json` with
`duplicates.enabled: true`. Only the coexistence service's input trust flag was
supplied through its existing injection seam so the real parser could inspect
this generated file; Pi itself still ran with `--no-approve`. **This is controlled
real-host workflow evidence, not acceptance of an actual trusted project's
configuration or a running second analyzer.** No Fallow process was launched.
Explicit jscpd analysis remained available while automatic warnings were
suppressed. Both sessions had zero extension errors or stderr output; all owned
reports and generated sources were removed.

The fixture establishes clean silence, new-finding delivery, acknowledgement,
and positive-signal suppression through real tool/lifecycle dispatch. It does
not satisfy the representative-real-repository or finding-usefulness matrix.

### Current-checkout usefulness triage: project B

The approved working tree continued evolving between validation sessions. A fresh
read-only review found **60 pairs across 141 sources**, rather than the earlier
58/134. Analyzed lines ranged from 43,766 to 43,776 between invocations; duplicated
lines remained 591. This is a later working-tree observation, **not** a measured
session delta or a regression. Before/after in-memory content fingerprints matched
within each review invocation and across the subsequent three-session host run.
No paths, identifiers, source fragments, AST dumps, or fingerprints were retained.

| Pair location | Count |
| --- | --- |
| Python implementation on both sides | 16 |
| Implementation matched to a test | 1 |
| Tests on both sides | 38 |
| Documentation and other scripts/resources | 5 |
| **Total** | **60** |

Pair formats were Python (46), JavaScript (10), Markdown (3), and Bash (1).
A bounded structural triage covered all 60 locations and examined Python
statement/function context in memory. It produced the following **provisional
review priorities**, not a semantic audit or maintainer-approved refactor list:

| Assessment | Pairs | Evidence and action |
| --- | --- | --- |
| Production inspection candidates | 4 | Identical nonempty complete-statement lists inside distinct implementation functions; inspect before considering extraction |
| Likely expected test repetition; lower priority | 26 | Both enclosing Python functions are tests containing assertions; preserve independent test readability by default |
| Uncertain | 30 | Remaining implementation, test helpers/JS, cross-boundary, documentation, and script matches lack enough semantic evidence for a recommendation |

The four production candidates span 8, 7, 7, and 11 lines: three same-file pairs
and one cross-file pair. Their repeated operations involve list construction
and iteration, path resolution/validation, and conditional input guards. These
are useful leads, not four independent ready-to-apply refactors: surrounding
context managers, policy differences, free variables, and error behavior still
matter. The enclosing function bodies are not identical.

Of the 26 lower-priority Python test pairs, 25 join distinct test functions; one
repeats within a test. This supports leaving those patterns alone during the
current refactor, **not** claiming the owner intended every duplicate or that
tests should be ignored globally. No extraction is confirmed safe, and no
maintainer-intent count is claimed. In particular, 38 test/test pairs are not
38 proven false positives.

Other implementation matches include fragments of string constants, dictionary
construction, function boundaries, and repeated branches. Token duplication alone
is insufficient to recommend merging those contracts. AST inspection was only a
local review aid; it did not replace jscpd detection, filter results, change
ranking, or introduce a Python dependency into the extension.

### Current real-host scope and installed-Fallow checks: project B

Three fresh isolated Pi 0.85.1 processes explicitly loaded both the source jscpd
extension and installed pi-fallow 0.5.1. Both tools registered successfully.
No Fallow analyzer process, mutation tool, or provider was invoked; all results
below came from the real registered jscpd tool and production services.

| Operation | Runs (ms) | Results in every run |
| --- | --- | --- |
| Baseline | 255, 266, 239 | Accepted |
| Full project | 177, 163, 161 | 60 pairs; 10 surfaced, 50 omitted |
| Python implementation | 65, 61, 59 | 16 pairs; 10 surfaced, 6 omitted |
| JavaScript extensions | 57, 53, 50 | Clean |
| Two Bash files with an existing match | 58, 57, 53 | One pair; one surfaced, zero omitted |
| No-mutation changed | 1, 1, 1 | Clean; zero surfaced/omitted |

This adds explicit real-host Python and Bash scope coverage, not merely detected
format names. The Bash scope was selected from the real full-project report,
without changing ignore rules or thresholds; it is intentionally not a random
sample or a whole-repository Bash census.

The checkout contains JSONC Fallow policy. With Pi project trust left unapproved,
coexistence remained **ambiguous / automatic allowed**, even with the actual
Fallow tool registered. This is successful two-extension loading and conservative
ambiguous-policy behavior, not positive configured-duplication acceptance. The
separate positive-signal fixture above remains the evidence for suppression.
All three sessions had zero extension errors, stderr output, provider turns, or
remaining report directories. The original working-tree contents were unchanged.

### Large public repository: project C (`vitejs/vite`)

Public TypeScript monorepo `vitejs/vite` at `bd3a3a9`, cloned read-only into an
owned temporary directory. No project-local jscpd policy. Same host, Node 24.12.0,
Pi 0.85.1 fixture, and pinned jscpd 5.1.2 as above. Analyzer-reported size: 1,107
sources and 172,464 lines (1,000–9,999 source bucket; 100,000–499,999 line bucket).
Counts were stable across three CLI samples per scope. Every report directory was
removed.

| Scope | First / later runs (ms) | Clone pairs per run |
| --- | --- | --- |
| Project | 362 / 210 / 249 | 524 |
| `packages` | 117 / 114 / 111 | 247 |
| `docs` | 60 / 59 / 61 | 66 |

Three fresh isolated Pi 0.85.1 RPC sessions loaded only the source extension,
offline, with discovery and built-in tools disabled. Explicit `/jscpd scan`
returned the same 524-pair summary in 447, 382, and 391 ms. Each notify was 47
lines and 2,809 characters. A `/jscpd scan packages` run returned 247 pairs in
259 ms. No extension stderr and no leftover report directories.

This is real-host slash-command evidence on a public 1,000+ source tree, not a
TUI overlay run against 524 findings and not a session-delta usefulness review.
Sub-second full scans do not activate persistent or incremental transport.

## Reproduction procedure

1. Use an explicitly approved target; reuse its existing authorization while
   scope remains unchanged. Record only a repository alias,
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
5. For precise cancellation, timestamp actual `abort()` delivery and callback
   settlement in Pi. Enumerate its descendants and process groups from an
   external process, not synchronous callbacks in the measured event loop.
   Retain counts only; check the observed IDs/groups before and after shutdown.
   For a controlled timeout, wrap the production config service's `current()`
   result to set `timeoutMs: 100` after baseline acceptance, without changing
   target policy. Restore it before testing absent-target failure and recovery.
6. For live transcripts, register a no-I/O local scripted provider using Pi's
   `streamSimple` API. It emits one predetermined `jscpd_run` tool call followed
   by a stop message. Do not replace tool execution. Count the original result
   component's rendered lines for compact/expanded states, press Ctrl+O twice,
   and repeat in regular/fullscreen modes at each width. Select one overlay
   finding and load it into the editor; clear it without submission and confirm
   stream-call counts did not change. Disable all built-in tools for real targets.
7. For synthetic mutation checks, create a temporary project containing one
   generated Python function exceeding jscpd's normal minimum thresholds. Permit
   only built-in `write` and `jscpd_run` in the local scripted session. Write a
   short unique note, await the automatic clean result, then write an identical
   Python file and await the automatic finding. Check acknowledgement with an
   explicit changed scan. Repeat in a fresh fixture with the controlled positive
   Fallow signal described above; expect no automatic attempts but an explicit
   changed finding. Record aggregate states only, then remove the fixture.
8. Never enable a remote provider or automatically submit a finding handoff.
   Do not infer project trust for a child from the parent session. Mutation
   scenarios belong only in disposable, explicitly scoped fixtures or copies.
   Launch drivers with an allowlisted environment, isolated home/agent/temp
   directories, no discovery, offline mode, and bounded run deadlines.

9. For privacy-preserving triage, consume the bounded real report in memory.
   Count pair formats and coarse source/test/documentation areas. For Python,
   parse the existing source without importing or executing it; find the smallest
   enclosing function covering each occurrence, count complete statements within
   the reported line span, and compare their `ast.dump` values in memory. Treat
   nonempty identical lists in distinct implementation functions as inspection
   candidates, not extraction approvals. Check test-function names and assertions
   before assigning lower priority; leave unsupported semantic judgments uncertain.
   Emit only aggregate counts and generic structural descriptions. Discard every
   raw report and fingerprint, and never turn this local aid into a detection rule.
10. To reproduce installed-extension coexistence, explicitly load a reviewed local
    pi-fallow entrypoint alongside jscpd into the isolated RPC host, with all
    discovery and built-in tools disabled. Check both registrations and jscpd
    status; do not run Fallow merely to establish tool presence. Repeat full,
    implementation, clean JavaScript, and report-selected Bash scopes in three
    fresh processes. Keep trust unchanged and distinguish ambiguous from positive
    policy evidence.
11. For the public large-repository sample, clone `vitejs/vite` at `bd3a3a9` into
    an owned temporary directory. Use the pinned analyzer without `--config`.
    Repeat project, `packages`, and `docs` CLI scopes three times with a 120-second
    bound. Then load the source extension into three isolated Pi 0.85.1 RPC hosts
    and time `/jscpd scan` until the notify summary arrives. Record only timings,
    pair counts, notify line/character bounds, and cleanup. Delete the clone.
    Do not retain template paths from the notify body.

## Remaining acceptance and decision

- Small and large source-count buckets now have real analyzer evidence: projects A
  and B (100–999 sources) plus public project C (1,107 sources / 172,464 lines).
  Full scans stayed well under one second. This does not claim a 10,000-source
  result and does not activate persistent or incremental transport.
- Cancellation, observed process-group cleanup, controlled timeout/failure, live
  compact/expanded transcripts, fullscreen UI, and selection/handoff have real-host
  observations against project B. Project C adds RPC slash-command scan timings,
  not a 524-finding TUI overlay rerun.
- Positive coexistence and mutation/clean-checkpoint behavior have controlled
  real-host observations. Representative trusted-project Fallow duplication policy
  was not accepted on project B; the synthetic positive-signal fixture remains the
  suppression evidence. That gap does not activate team-policy work.
- Usefulness has a bounded triage on project B: four production inspection
  candidates, 26 likely expected test repetitions, and 30 uncertain pairs in the
  60-pair snapshot. Safe extraction and maintainer intent remain unproven.

**Decision: no demonstrated product problem should drive a new feature milestone.**
Keep advisory, quiet defaults and current thresholds. Do not start a performance,
navigation, team-policy, or noise feature on this evidence. Candidates #103–#106
stay deferred until new evidence appears.

No extension defect was established, so no speculative defect issue was filed.
