# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
published releases will use [Semantic Versioning](https://semver.org/). The
package is currently private and unreleased; entries remain under `Unreleased`
until publication is approved.

## [Unreleased]

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
- Conservative Pi Fallow coexistence policy with explicit on-demand and allow
  choices.
- Confirmed `pi-jscpd` package identity and a tested Node/Pi/TypeBox
  compatibility policy.
- Public CI, dependency-update policy, contribution guidance, security policy,
  issue forms, pull-request guidance, and release ownership.
- Exact packed-artifact certification with isolated Pi RPC/tool/TUI-compatible,
  JSON, print, process-tree shutdown, and temporary-report cleanup checks.
- Non-publishing release-readiness workflow, provenance/access intent,
  documentation-link validation, repository-hygiene guards, and a future release,
  rollback, and post-release policy.

### Changed

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
  exact-tarball recertification while retaining private version `0.0.0`.
  Completion remains separate from any version or publication approval.

### Security

- Project paths, child output, reports, temporary directories, cancellation,
  configuration trust, and lifecycle cleanup are bounded and fail open.

[Unreleased]: https://github.com/revazi/pi-jscpd/commits/main
