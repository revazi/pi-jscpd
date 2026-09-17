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

| Project | Pin | Sources | Duplicate blocks | Dup. lines | Median `/jscpd scan` |
| --- | --- | ---: | ---: | ---: | ---: |
| [Vite](https://github.com/vitejs/vite) | [v8.3.0](https://github.com/vitejs/vite/tree/434e8e9495436a60789f2b588a04a6a24a3d1661) | 1,107 | 524 | 5.91% | 498 ms |
| [React](https://github.com/facebook/react) | [v19.3.0](https://github.com/facebook/react/tree/1d34f91dfde6bba84d08b683aaba164c7194dacb) | 7,962 | 10,812 | 17.38% | 3.11 s |
| [Vue](https://github.com/vuejs/core) | [v3.5.43](https://github.com/vuejs/core/tree/5be58b4c475c1d14b4abacbfeda610394a0ee4e5) | 598 | 805 | 6.71% | 451 ms |
| [Svelte](https://github.com/sveltejs/svelte) | [svelte@5.57.0](https://github.com/sveltejs/svelte/tree/7bc0a70fe64dbb3fa3848b741963f31d1e10a8dc) | 4,499 | 1,102 | 8.27% | 1.25 s |
| [Express](https://github.com/expressjs/express) | [v5.2.1](https://github.com/expressjs/express/tree/dbac741a49a5a64336b70c06e85c2e2706e36336) | 183 | 274 | 11.19% | 142 ms |
| [Prettier](https://github.com/prettier/prettier) | [3.9.8](https://github.com/prettier/prettier/tree/4f2ab6765d7cb29408a2abdac75d023d64d44107) | 3,320 | 976 | 4.88% | 1.16 s |

Every row returned findings. Notifies stayed at 47 lines (presentation cap).
React and Svelte keep jscpd’s full totals; the session retains at most 1,000
path-resolved pairs and does not keep source fragments or the raw JSON.

Prettier clone counts were 976 / 982 / 976. The table keeps the repeating
976 / 4.88% snapshot.

Sample `/jscpd scan` times (ms):

| Project | First | Later | Median |
| --- | ---: | ---: | ---: |
| Vite | 560 | 470, 498 | 498 |
| React | 3,107 | 3,210, 2,974 | 3,107 |
| Vue | 399 | 459, 451 | 451 |
| Svelte | 1,292 | 1,251, 1,241 | 1,251 |
| Express | 142 | 141, 145 | 142 |
| Prettier | 1,163 | 1,112, 1,177 | 1,163 |

## How to read this

- This is the extension’s explicit project scan, not `jscpd` invoked by hand
  and not a TUI overlay run.
- **Sources** and **duplicate blocks** come from the public notify summary after
  decoding. They are jscpd totals, even when extra pairs are omitted from the
  listed findings.
- **Median scan** is not a SLA. It includes analyzer work plus `pi-jscpd`
  decoding and presentation.
- A higher percentage is not “worse code.” Scaffolding and tests duplicate on
  purpose.

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
