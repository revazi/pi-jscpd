# Contributing to pi-jscpd

Thanks for helping improve `pi-jscpd`. Changes should preserve the extension's
quiet, advisory, read-only, bounded, and fail-open behavior. jscpd remains the
authority for tokenization, clone detection, supported formats, and duplication
statistics. The Effect runtime architecture is documented in
[Effect architecture and conformance](docs/effect-architecture.md). Changes must
preserve those product contracts and the completed runtime boundaries.

## Before opening a change

1. Search the [issue tracker](https://github.com/revazi/pi-jscpd/issues).
2. Open or select a focused issue before substantial implementation work.
3. Discuss changes to public commands/tools, configuration, persisted session
   state, process ownership, or product invariants before coding.
4. For Effect work, select the next unblocked subissue under
   [#63](https://github.com/revazi/pi-jscpd/issues/63); do not bypass its dependency order.
5. Report suspected vulnerabilities privately according to
   [SECURITY.md](SECURITY.md), not in a public issue.

Feature requests should explain why normal jscpd configuration or Pi's ordinary
agent flow is insufficient. Do not propose an independent clone detector,
automatic source edits, surprise binary installation, or mandatory
JavaScript-only parsing in the core workflow.

## Development setup

Use a host from the [compatibility matrix](docs/compatibility.md). Install the
locked dependencies without changing global Pi configuration:

```text
npm ci --ignore-scripts
npm run docs:check
npm run repo:hygiene
npm run check
npm run pack:certify
npm run pack:dry-run
```

`npm run check` validates the active Node/Pi/Effect fixtures, enforces the
approved Effect runtime boundary, type checks strict ESM TypeScript, runs
Biome's formatting/lint checks, and executes the network-free test suite. The
documentation and hygiene checks validate public local links,
release guards, ignored/private path policy, package metadata, and the
non-publishing workflow. `pack:certify` installs and exercises the exact tarball.
CI repeats those checks on Node 22.19.0 and 24.12.0.

Tests must not require network access, read or modify global Pi configuration,
write reports into a source tree, or depend on a separately installed jscpd
binary. Use deterministic fake executables for controlled reports and process
lifecycle cases. Capability and packed-artifact checks also probe the exact
jscpd runtime dependency declared by the package. The repository's Fallow
configuration records that indirect CLI use and disables Fallow clone detection
so jscpd remains this project's single duplication authority.

## Effect migration rules

- Use Effect for fallible async work, resources, cancellation, concurrency, and
  shared service state—not to decorate pure functions.
- Declare capabilities with services/layers and keep the single production
  runtime in the Pi composition boundary. Process and filesystem services provide
  live layers but create no independent runtime.
- Keep `Effect.run*` out of infrastructure, domain, and application modules.
  Only `src/effect/runtime-boundary.ts` may execute production Effect programs;
  do not add another runtime bridge.
- Add characterization tests before converting a boundary, deterministic test
  layers with the conversion, and interruption/finalizer tests for resources.
  Filesystem changes must preserve trust gating, canonical containment,
  no-follow opens, exact byte bounds, atomic decode rejection, and body-free
  diagnostics. Stateful domain changes must use one owner per layer/facade,
  preserve immutable snapshots and generation/revision checks, and test stale
  completion plus competing updates. Scheduler and automatic-check changes must
  use scoped fibers, preserve explicit-work priority and retry eligibility, and
  commit acknowledgements only after successful quiet Pi delivery. Application
  workflows must compose existing service effects, keep public result mapping at
  one boundary, and leave deterministic comparison/presentation code pure. Only
  `src/effect/runtime-boundary.ts` may execute Effect; production work must use
  the single runtime passed from extension composition.
- Do not add Promise service facades. Promise workflow orchestration is limited
  to reviewed Pi/TUI host adapters and the filesystem infrastructure boundary;
  characterization adapters belong under `test/support/`.
- Do not combine a migration slice with unrelated public behavior changes.

## Pull requests

Keep one concern per pull request and include:

- the problem and user-visible behavior;
- the issue it closes;
- tests for success, no-findings, and relevant failure/cancellation paths;
- documentation for behavior or compatibility changes;
- for Effect slices, the prerequisite issue, removed legacy path, typed failures,
  layer graph, interruption/finalizer evidence, and approved runtime boundary;
  and
- exact validation performed.

Before requesting review, run:

```text
npm run format
npm run docs:check
npm run repo:hygiene
npm run check
npm run pack:certify
npm run pack:dry-run
```

The protected `main` branch requires the branch to be current and both
`Validate (Node 22.19.0)` and `Validate (Node 24.12.0)` to pass. The rule applies
to administrators, requires resolved review conversations, and blocks force
pushes and branch deletion. Reviews and CI are evidence, not authorization to
publish.

Keep credentials, proprietary source, source fragments from jscpd reports,
private paths, generated reports, local overrides, `.agents/`, and `AGENTS.md`
out of commits. Contributors remain responsible for reviewing and understanding
all submitted changes, including AI-assisted changes.

## Dependency updates

Repository vulnerability alerts and Dependabot security updates are enabled.
Dependabot also checks direct npm dependencies and GitHub Actions monthly. Pi
0.84 patches and compatible development-tooling updates are grouped. Major
updates to development tools and Pi minor/major updates are ignored because they
need deliberate recertification. The minimum TypeBox fixture is excluded from
scheduled version updates and changes only through a focused compatibility
review; vulnerability alerts and security updates remain enabled. The Effect
runtime must be exact-pinned and updated only through a focused architecture and
compatibility review. GitHub Actions are SHA-pinned and updates must retain
least-privilege permissions.

A dependency PR must pass both Node jobs. Pi, TypeBox-major, Node-range, and
workflow changes also require the manual compatibility evidence described in
[`docs/compatibility.md`](docs/compatibility.md).

## Release ownership

Only [Revaz Zakalashvili](https://github.com/revazi), as package maintainer and
repository owner, may approve a version, remove `"private": true`, create a tag,
configure registry authentication, or publish. The current manual workflow is
readiness-only: it has no registry credentials or write permission and cannot
release anything. The Effect epic and final recertification must close before a
version can be proposed, but their completion does not grant release authority.
Follow [the release preparation policy](docs/release.md). A contributor,
reviewer, CODEOWNERS approval, or passing CI does not grant publication authority.
