# 📊 Public framework snapshots

These rows are **duplication snapshots**, not a code-quality ranking and not a
session-delta report. `pi-jscpd` does not edit those projects. Templates,
examples, tests, and generated fixtures are part of a full-tree scan and often
explain a large share of duplicate blocks.

Analyzer: packaged [jscpd](https://github.com/kucherenko/jscpd) `5.1.2`. Host:
macOS arm64, Node 24.12.0. Date: 2026-09-17. No project `.jscpd.json` was
present, so default detection policy applied. Each tree was a shallow clone of
the listed tag into an owned temporary directory; reports lived in a separate
temp directory and were removed.

Three sequential full-tree CLI samples per project. Times include process
startup. The table uses the median wall time. Clone counts were stable except
where noted.

## Snapshot

| Project | Pin | Sources | Lines | Duplicate blocks | Duplicated lines | Dup. lines | Median scan |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Vite](https://github.com/vitejs/vite) | [v8.3.0](https://github.com/vitejs/vite/tree/434e8e9495436a60789f2b588a04a6a24a3d1661) | 1,107 | 172,410 | 524 | 10,191 | 5.91% | 249 ms |
| [React](https://github.com/facebook/react) | [v19.3.0](https://github.com/facebook/react/tree/1d34f91dfde6bba84d08b683aaba164c7194dacb) | 7,962 | 1,145,270 | 10,812 | 199,042 | 17.38% | 1,460 ms |
| [Vue](https://github.com/vuejs/core) | [v3.5.43](https://github.com/vuejs/core/tree/5be58b4c475c1d14b4abacbfeda610394a0ee4e5) | 598 | 182,248 | 805 | 12,228 | 6.71% | 152 ms |
| [Svelte](https://github.com/sveltejs/svelte) | [svelte@5.57.0](https://github.com/sveltejs/svelte/tree/7bc0a70fe64dbb3fa3848b741963f31d1e10a8dc) | 4,499 | 268,022 | 1,102 | 22,159 | 8.27% | 521 ms |
| [Express](https://github.com/expressjs/express) | [v5.2.1](https://github.com/expressjs/express/tree/dbac741a49a5a64336b70c06e85c2e2706e36336) | 183 | 27,329 | 274 | 3,059 | 11.19% | 75 ms |
| [Prettier](https://github.com/prettier/prettier) | [3.9.8](https://github.com/prettier/prettier/tree/4f2ab6765d7cb29408a2abdac75d023d64d44107) | 3,320 | 484,150 | 982 | 23,681 | 4.89% | 498 ms |

Prettier clone counts were 982 / 977 / 982 across the three samples. The table
keeps the repeating 982 / 23,681 snapshot.

Sample times (ms):

| Project | First | Later | Median |
| --- | ---: | ---: | ---: |
| Vite | 249 | 226, 281 | 249 |
| React | 1,796 | 1,460, 1,424 | 1,460 |
| Vue | 143 | 155, 152 | 152 |
| Svelte | 438 | 521, 540 | 521 |
| Express | 74 | 77, 75 | 75 |
| Prettier | 394 | 498, 588 | 498 |

## How to read this

- **Sources / lines** are what jscpd analyzed after its default ignore rules,
  not a hand count of the Git tree.
- **Duplicate blocks** are analyzer clone pairs on a full-tree scan. They are
  not `pi-jscpd` session findings and not a judgment that the project should
  refactor.
- **Median scan** is CLI wall time for one full-tree run with the packaged
  binary. It is not a SLA and not a Pi TUI overlay measurement.
- A higher percentage is not “worse code.” Scaffolding and tests duplicate on
  purpose.

Scheduled refresh of this table is tracked in
[issue #111](https://github.com/revazi/pi-jscpd/issues/111). Until that workflow
exists, treat these rows as a dated snapshot.

## Reproduction

On a supported Node fixture with this repository’s locked dependencies:

1. Shallow-clone each tag into an owned temporary directory.
2. Invoke `node_modules/.bin/jscpd` with cwd set to that clone and argument
   array `[".", "--reporters", "json", "--output", "<temp>", "--silent",
   "--no-colors", "--no-tips"]`.
3. Bound the process (180 seconds was used here), discard stdout/stderr, read
   only `statistics.total` from `jscpd-report.json`, and delete both temp
   directories.
4. Repeat three times. Publish the median time and, when counts are stable, the
   repeating totals.

Do not commit clones, reports, or source fragments.
