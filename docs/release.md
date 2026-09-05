# Release and publication policy

`pi-jscpd` releases are explicitly authorized by
[Revaz Zakalashvili](https://github.com/revazi) and published from reviewed tags
through `.github/workflows/release.yml`. CI, issue closure, package certification,
or CODEOWNERS review does not independently authorize a release.

The first public release is `0.1.0`. The required Effect migration and
recertification work is documented in
[Effect architecture and conformance](effect-architecture.md).

## Release gates

Run the complete gate from a clean supported checkout:

```text
npm ci --ignore-scripts
npm run release:check
```

`release:check` validates public Markdown links, repository hygiene, host
compatibility, strict types, Biome, the network-free test suite, the exact packed
and installed artifact, and the package dry run. CI repeats these checks on Node
22.19.0 and 24.12.0.

The manual **Release readiness (no publish)** workflow validates an exact
40-character commit that must resolve to `origin/main`. It has read-only
repository permission, receives no registry credential, retains no package
artifact, and cannot publish or create a GitHub release.

## Tagged publication workflow

`.github/workflows/release.yml` follows the `pi-fallow` release pattern. A pushed
`vMAJOR.MINOR.PATCH` tag starts one protected `npm` environment job that:

1. checks out the complete tag history without persisting credentials;
2. installs the pinned trusted-publishing npm version;
3. verifies tag/package/changelog and package-lock version agreement;
4. rejects a manifest that still has the npm `private` guard;
5. installs locked dependencies without lifecycle scripts;
6. reruns `npm run release:check`;
7. publishes publicly through npm trusted publishing with provenance and
   lifecycle scripts disabled; and
8. creates the matching GitHub release only after npm publication succeeds.

The first publication used a short-lived granular token isolated to the
lifecycle-disabled publish step because npm could not attach trusted-publisher
settings before the unscoped package existed. That repository secret and
workflow fallback were deleted immediately after npm confirmed `0.1.0`.

All later releases must use OIDC only. Default GitHub permissions are empty; the
release job receives only `contents: write` for the GitHub release and
`id-token: write` for trusted publishing. Before another tag is pushed, the
repository's protected `npm` environment and npm trusted-publisher binding must
match the exact repository and `.github/workflows/release.yml`. Authentication
details, token values, `.npmrc` files, screenshots, and credential output must
never be committed or copied into issues or CI logs.

## Version and changelog procedure

Published versions follow Semantic Versioning. For each approved release:

1. Move relevant entries from `Unreleased` to
   `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` and update comparison links.
2. Update `package.json` and `package-lock.json` together.
3. Confirm the package is publishable and `publishConfig` still requests public
   access and provenance.
4. Merge the reviewed release commit to `main` and wait for both supported-Node
   CI jobs to pass on that exact commit.
5. Run the manual non-publishing readiness workflow for the exact `main` SHA when
   additional release evidence is required.
6. Create one annotated `vMAJOR.MINOR.PATCH` tag on that exact commit and push it.
7. Watch the release workflow through npm publication and GitHub Release
   creation.

Do not move a tag, publish from an unreviewed checkout, bypass a failed gate, or
widen permissions to make a release pass.

## Failure and rollback policy

Before publication, any failed or ambiguous check means stop and discard or fix
the candidate. npm versions are immutable. After publication:

- never overwrite or silently replace a version;
- verify registry name, version, integrity, provenance, and source commit;
- deprecate a defective version with a concise migration message when needed;
- publish a corrected patch through the full process;
- use npm unpublish only when the maintainer determines it is necessary and
  allowed by npm policy; and
- coordinate security defects through GitHub private vulnerability reporting and
  [SECURITY.md](../SECURITY.md).

If GitHub Release creation fails after npm publication, verify npm first and
create the GitHub release for the same immutable tag. Do not republish merely to
repair release notes.

## Post-release verification

A release is complete only after the maintainer verifies:

1. npm metadata matches the approved name/version and reports integrity and
   provenance;
2. a disposable project installs that exact version without lifecycle scripts;
3. installed files match the certified allowlist;
4. supported Pi discovers `/jscpd`, `jscpd_run`, and `/skill:jscpd` without
   warnings in representative RPC, JSON, print, and TUI-compatible paths;
5. the package-owned jscpd route performs a controlled real scan;
6. damaged-analyzer behavior remains dormant and fail open;
7. Effect interruption closes active fibers and the root scope; and
8. shutdown leaves no child process or temporary report directory.

Record only bounded pass/fail evidence, public versions, and artifact digests.
Never retain source fragments, local paths, credentials, or environment dumps.
