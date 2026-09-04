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

### Security

- Project paths, child output, reports, temporary directories, cancellation,
  configuration trust, and lifecycle cleanup are bounded and fail open.

[Unreleased]: https://github.com/revazi/pi-jscpd/commits/main
