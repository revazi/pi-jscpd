# Release preparation and publication policy

Status: **preparation only; no release is authorized**

`pi-jscpd` is still `0.0.0` with `"private": true`. The repository has no npm
publication workflow, release tag, or published npm version. The manual
**Release readiness (no publish)** workflow only validates an exact reviewed
commit from `origin/main`; it has read-only repository permission, receives no
registry credential, persists no package artifact, and cannot publish or create
a GitHub release.

Only [Revaz Zakalashvili](https://github.com/revazi) may authorize a version,
remove the private-package guard, create a tag or GitHub release, configure npm
trusted publishing, or publish the package. CI success, package certification,
CODEOWNERS review, or this document is not publication approval.

The completed runtime and recertification design is documented in
[Effect architecture and conformance](effect-architecture.md). The first release
and any `0.1.0` proposal remain blocked by closure of
[tracking epic #63](https://github.com/revazi/pi-jscpd/issues/63) and its
prerequisites, followed by separate maintainer approval. Closing those issues
remains necessary but is not sufficient publication authority.

## Current non-publishing gate

Run the complete local gate from a clean supported checkout:

```text
npm ci --ignore-scripts
npm run release:check
```

`release:check` validates public Markdown links, repository hygiene, host
compatibility, strict types, Biome, the network-free test suite, the exact
installed tarball, and the package dry run. The separate manual readiness
workflow repeats that gate on Node 22.19.0 and 24.12.0 for a supplied
40-character commit that must resolve to `origin/main`.

These checks certify the current commit only. Until #63 and issues #64–#72 are
closed, passing them must not be described as first-release readiness.

The manifest declares future publication intent with:

```json
{
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

These settings do not override `"private": true`, provide authentication, claim
the npm name, or trigger publication. Development scripts are excluded from the
package except for the public compatibility checker already in the explicit
package allowlist.

## External ownership and authentication checks

Do not add npm tokens, account names, `.npmrc` files, command output, or
credential screenshots to this repository. After explicit release approval, the
maintainer must perform these checks outside the checkout and CI logs:

1. Confirm that the intended npm account and organization security controls are
   active using npm's official account interface and a local `npm whoami`
   request to `https://registry.npmjs.org/`.
2. Query the exact `pi-jscpd` name through npm's official registry. A missing
   package means only that the name appeared available at that moment; it does
   not reserve ownership.
3. Confirm that the account can create or administer the exact package name
   before changing repository release state.
4. Prefer npm trusted publishing with provenance. Configure it only after
   reviewing the exact repository, workflow filename, protected environment,
   and npm account/package binding. Any first-publication bootstrap credential
   must be short-lived, narrowly scoped, supplied outside repository files, and
   removed immediately afterward.
5. Never expose authentication through a pull request, issue, shell transcript,
   workflow input, repository secret name in documentation examples, or package
   artifact.

If any ownership or authentication check is uncertain, stop. Do not change the
version, private guard, changelog, tag, or workflow permissions.

## Versioning and changelog procedure

Published versions will follow Semantic Versioning. Version selection is a
maintainer decision based on the public contract, not an automatic consequence
of merged commits.

Only after every Effect migration issue closes and a separate maintainer review
accepts the final architecture, a future approved release pull request may:

1. Select one stable `MAJOR.MINOR.PATCH` version; prerelease versions require a
   separately documented channel and dist-tag policy.
2. Move the relevant `Unreleased` entries in `CHANGELOG.md` into
   `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, leave a new empty `Unreleased` section,
   and add comparison links.
3. Update `package.json` and `package-lock.json` together without creating a tag.
4. Replace documentation that says the package is private or not installable
   only when publication is actually authorized and imminent.
5. Run both protected CI jobs and the manual readiness workflow for the exact
   reviewed commit.
6. Inspect the certified tarball file list, manifest, integrity, and smoke-test
   evidence again before any state-changing release step.

No automation in the current repository performs these edits.

## Future publication activation

Publication requires completed Effect migration/recertification **and** a
separate, explicitly approved change. That change must be reviewed before it can:

- remove `"private": true`;
- add any job with npm registry authentication or GitHub OIDC permission;
- create or consume a release tag;
- retain or publish a tarball;
- create a GitHub release; or
- invoke an npm publication command.

A future publishing workflow must bind an exact stable SemVer version to an
annotated tag and reviewed `main` commit, use a protected production environment,
keep default permissions empty, grant only job-local `contents: read` and the
minimum trusted-publishing permission, reject long-lived credentials, rerun the
complete release gate, and publish the already certified artifact exactly once.
It must fail closed before publication when source, tag, version, changelog,
ownership, provenance, or artifact identity differs.

## Failure and rollback policy

Before publication, any failed or ambiguous check means stop and discard the
candidate. Do not work around certification, retag a different commit, or widen
permissions to make a release pass.

npm versions are immutable. After publication:

- do not overwrite or silently replace the version;
- verify the registry's name, version, integrity, provenance, and source commit;
- deprecate a defective version with a concise migration message when needed;
- publish a corrected patch through the full process;
- use npm unpublish only when the maintainer determines it is necessary and
  allowed by npm policy; and
- use GitHub private vulnerability reporting for security defects, coordinating
  an advisory and disclosure timeline according to [SECURITY.md](../SECURITY.md).

If a GitHub release fails after npm publication, verify npm first and create the
GitHub release for the same immutable tag and artifact; never republish merely
to repair release notes.

## Post-release smoke checks

A future release is incomplete until the maintainer verifies, without exposing
credentials:

1. npm registry metadata exactly matches the approved name and version and
   reports package integrity and provenance;
2. a disposable project installs that exact public version without lifecycle
   scripts or global Pi configuration;
3. the installed package has the same allowlisted files as the certified
   candidate;
4. supported Pi discovers `/jscpd` and `jscpd_run` without warnings in the
   representative RPC, JSON, print, and TUI-compatible paths;
5. the package-owned jscpd route works and damaged-install behavior remains
   dormant and fail open;
6. a controlled package-owned jscpd v5 smoke confirms one real scan;
7. Effect interruption closes active fibers and the root scope; and
8. shutdown leaves no child process or temporary report directory.

Record only bounded pass/fail evidence, public versions, and artifact digests.
Never retain source fragments, local paths, credentials, or environment dumps.
