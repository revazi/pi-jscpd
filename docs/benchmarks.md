# 📊 pi-jscpd benchmarks

These rows are **pi-jscpd benchmarks**, not a raw `jscpd` CLI. Each sample loads the
source extension into an isolated Pi 0.85.1 RPC host and runs `/jscpd scan` on a
pinned public tree. jscpd `5.1.2` remains the detector; the times and outcomes
include capability resolution, report decoding, normalization, and the public
notify. They are **full-tree duplication snapshots**, not session-delta findings
and not a code-quality ranking.

Host: macOS arm64, Node 24.12.0, Pi 0.85.1, packaged jscpd `5.1.2`. Date:
2026-09-17. No project `.jscpd.json`. Shallow clones of the listed tags. Reports
stayed in owned temporary directories and were removed. Pi ran offline, without
discovery, project trust, session persistence, a provider, or built-in tools.

Three fresh Pi processes per project. **Scan** is milliseconds from `/jscpd scan`
until the extension notify. Host ready (start + command discovery) was about
1.2–1.5 s and is **not** included in scan time.

## pi-jscpd snapshot

| Project | Pin | Outcome | Sources | Duplicate blocks | Dup. lines | Median `/jscpd scan` |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| [Vite](https://github.com/vitejs/vite) | [v8.3.0](https://github.com/vitejs/vite/tree/434e8e9495436a60789f2b588a04a6a24a3d1661) | Findings | 1,107 | 524 | 5.91% | 520 ms |
| [React](https://github.com/facebook/react) | [v19.3.0](https://github.com/facebook/react/tree/1d34f91dfde6bba84d08b683aaba164c7194dacb) | Fail-open, invalid report | — | — | — | 2.68 s |
| [Vue](https://github.com/vuejs/core) | [v3.5.43](https://github.com/vuejs/core/tree/5be58b4c475c1d14b4abacbfeda610394a0ee4e5) | Findings | 598 | 805 | 6.71% | 417 ms |
| [Svelte](https://github.com/sveltejs/svelte) | [svelte@5.57.0](https://github.com/sveltejs/svelte/tree/7bc0a70fe64dbb3fa3848b741963f31d1e10a8dc) | Fail-open, invalid report | — | — | — | 808 ms |
| [Express](https://github.com/expressjs/express) | [v5.2.1](https://github.com/expressjs/express/tree/dbac741a49a5a64336b70c06e85c2e2706e36336) | Findings | 183 | 274 | 11.19% | 152 ms |
| [Prettier](https://github.com/prettier/prettier) | [3.9.8](https://github.com/prettier/prettier/tree/4f2ab6765d7cb29408a2abdac75d023d64d44107) | Findings | 3,320 | 981 | 4.89% | 1.23 s |

React and Svelte returned the public fail-open message
`jscpd produced an invalid structured report; no result was used.` The default
report bound is 16 MiB. A raw analyzer CLI can still print totals on those trees;
`pi-jscpd` does not use an oversized or malformed report. Pi continued, stderr
stayed empty, and no report directories remained.

Successful notifies were 47 lines (presentation cap). Prettier counts were
976, then 981, then 981; the table keeps the repeating 981 / 4.89% snapshot.

Sample `/jscpd scan` times (ms):

| Project | First | Later | Median |
| --- | ---: | ---: | ---: |
| Vite | 600 | 520, 467 | 520 |
| React (fail-open) | 3,200 | 2,678, 2,569 | 2,678 |
| Vue | 405 | 417, 430 | 417 |
| Svelte (fail-open) | 819 | 763, 808 | 808 |
| Express | 153 | 152, 151 | 152 |
| Prettier | 1,257 | 1,232, 1,144 | 1,232 |

## How to read this

- This is the extension’s explicit project scan, not `jscpd` invoked by hand
  and not a TUI overlay run.
- **Sources** and **duplicate blocks** come from the public notify summary after
  decoding. Fail-open rows have no used result.
- **Median scan** is not a SLA. It includes analyzer work plus `pi-jscpd`
  decoding and presentation.
- A higher percentage is not “worse code.” Scaffolding and tests duplicate on
  purpose.
- Fail-open is success for the product invariant: a huge report must not break
  Pi.

Scheduled refresh is tracked in
[issue #111](https://github.com/revazi/pi-jscpd/issues/111).

## Reproduction

On a supported Node fixture with this repository’s locked dependencies:

1. Shallow-clone each tag into an owned temporary directory.
2. Start isolated Pi 0.85.1 in RPC mode: offline, no session, no discovery, no
   project trust, no built-in tools, `--tools jscpd_run`, and `-e` pointing at
   this source extension. Put the packaged `node_modules/.bin` on `PATH`.
3. After the host is ready, send `/jscpd scan`. Time until the extension notify.
   Keep only the summary line (counts and timings). Do not retain notify bodies,
   paths, or reports.
4. Repeat in three fresh Pi processes. Confirm stderr is empty and report
   directories are gone after shutdown.
5. Delete the clone.

Do not commit clones, reports, or source fragments.
