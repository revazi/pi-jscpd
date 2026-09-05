# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
published releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- Removed the one-time npm bootstrap credential path and repository secret after
  the registry confirmed `0.1.0`; future releases use trusted publishing only.

## [0.1.0] - 2026-09-05

### Added

- Pi-native `jscpd_run` tool and namespaced `/jscpd` command surface.
- Pinned jscpd `5.1.2` runtime dependency with project-local, `PATH`, and bundled
  resolution, plus bounded shell-free process ownership and no runtime download.
- Exact Effect `3.22.1` runtime foundation with declarative process, filesystem,
  clock, and Pi service tags, stable typed expected failures, bounded public
  mapping intent, deterministic test layers, and an AST runtime-boundary gate.
- Effect-owned bounded child processes, process-tree escalation, serialized jscpd
  execution, temporary report workspaces, capability probing/caching, and scoped
  service layers.
- A shared live bounded-filesystem layer for trusted configuration, canonical
  path validation, report normalization, exact clone-source ranges, and supported
  Fallow signal reads, with typed failures and deterministic test layers.
- Effect-owned baseline generations, changed-file attribution, acknowledgement
  transactions, verification checkpoints, and typed branch-snapshot persistence,
  with immutable values and lifecycle-scoped state owners.
- Scoped Effect scheduling for dirty-generation coalescing, automatic changed
  checks, interruption-safe cancellation, and acknowledgement-after-delivery Pi
  transactions without unmanaged background promises or timers.
- Effect-composed scan, changed, status/session-control, Fallow coexistence,
  report-decoding, and verification workflows with unchanged bounded public
  results.
- One managed Effect runtime and production process/filesystem/clock layer graph
  per extension instance, with native Pi cancellation, effectful dispatch,
  idempotent finalizer-aware shutdown, and no nested command/overlay runtimes.
- Strict normalized jscpd JSON report validation and scope-safe explicit scans.
- Trusted extension configuration, session controls, branch-local state, and
  changed-file attribution.
- Ephemeral session baselines, content-aware clone identity, changed-only
  findings, acknowledgements, and quiet automatic settled checks.
- Responsive `/jscpd` overview, shared actionable finding presentation, and
  ephemeral refactor verification.
- TUI root-subcommand autocomplete for `/jscpd ` with labeled scan, changed,
  status, session-control, and help suggestions.
- Packaged on-demand `jscpd` skill with polyglot scan routing, result
  interpretation, verification, configuration, Fallow-coexistence, and advisory
  safety guidance.
- Conservative Pi Fallow coexistence policy with explicit on-demand and allow
  choices.
- Confirmed `pi-jscpd` package identity and a tested Node/Pi/TypeBox
  compatibility policy.
- Public CI, dependency-update policy, contribution guidance, security policy,
  issue forms, pull-request guidance, and release ownership.
- Exact packed-artifact certification with isolated Pi RPC/tool/TUI-compatible,
  JSON, print, process-tree shutdown, and temporary-report cleanup checks.
- Non-publishing release-readiness workflow, provenance/access intent,
  documentation-link validation, repository-hygiene guards, and release,
  rollback, and post-release policy.
- A tag-triggered npm trusted-publishing and GitHub Release workflow based on
  `pi-fallow`, protected by release metadata and maintainer-approval guards. Its
  first-publication bootstrap credential is isolated to the lifecycle-disabled
  publish step and removed after `0.1.0`.

### Changed

- Reworked the `/jscpd` overlay into a Pi Fallow-style findings navigator with
  framed status/count hierarchy, responsive two-location rows, inline detail,
  search, scrolling, multi-selection, and bounded editor prompt handoff. The
  overlay now retains up to 100 findings in memory, initially reveals 10, and
  loads subsequent 10-item pages manually or when navigation crosses the shown
  boundary without enlarging configured model/tool output or persisted state.
- Accepted valid jscpd v5 reports whose token-equivalent second occurrence spans
  fewer physical lines than the reporter's first-occurrence line count.
- Added repository jscpd ignore policy for dependency/build artifacts, caches,
  generated source maps/snapshots, archives, and common polyglot lockfiles.
- Kept packed-artifact cleanup verification bounded while allowing slower Node 22
  CI runners enough time to observe completed temporary-directory finalization.
- Removed superseded process, capability, analyzer, configuration,
  Fallow-coexistence, baseline, changed-file, command/status, and
  scheduler/automatic Promise facades; removed the parallel Promise report
  consumer, direct analyzer filesystem workflow, production test runtime, and
  filesystem-backed clone/report test facades. Service workflows now expose only
  their Effect-native production paths; Promise orchestration remains confined to
  reviewed Pi/TUI and filesystem-infrastructure boundaries.
- Locked existing command/tool, lifecycle, persistence, cancellation, and bounded
  presentation behavior before production Effect workflow migration.
- Completed the ordered Effect runtime migration, legacy-removal audit,
  documentation pass, supported-Node validation, security checks, and
  exact-tarball recertification required for the first public release.

### Security

- Project paths, child output, reports, temporary directories, cancellation,
  configuration trust, and lifecycle cleanup are bounded and fail open.

[Unreleased]: https://github.com/revazi/pi-jscpd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/revazi/pi-jscpd/releases/tag/v0.1.0
