# Security policy

## Supported versions

`pi-jscpd` has not published an npm release. Security fixes currently target the
latest `main` branch only. Version `0.0.0` and repository snapshots are
unreleased development artifacts, not supported distribution channels.

After the first approved release, this table will identify maintained release
lines and the changelog will identify security-relevant updates. The current
manual release-readiness workflow cannot publish or create a release; the
[release policy](docs/release.md) defines the separate approval, rollback, and
post-release checks.

| Version | Supported |
| --- | --- |
| Latest `main` | Development fixes only |
| npm releases | None yet |

The host-version contract is documented in
[`docs/compatibility.md`](docs/compatibility.md). Forced installations outside
that contract are unsupported, but reports of issues that affect a supported
configuration are welcome.

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/revazi/pi-jscpd/security/advisories/new)
to contact the maintainer. If GitHub does not offer the form, contact the
repository owner privately through their GitHub profile and ask for a secure
reporting channel without including vulnerability details in the first message.

Include only what is needed to reproduce and assess the problem:

- affected commit or version;
- supported Node and Pi versions;
- operating system;
- bounded reproduction steps using synthetic source where possible;
- expected and observed security impact; and
- whether disclosure is already public or time-sensitive.

Do not send credentials, tokens, proprietary source, full environment dumps,
raw jscpd fragments, or unrelated filesystem paths. Replace them with minimal
fixtures and redacted diagnostics.

The maintainer aims to acknowledge a complete report within five business days,
will coordinate validation and remediation privately, and will discuss a safe
disclosure timeline with the reporter. This is a best-effort open-source target,
not a guaranteed service-level agreement. Please allow a reasonable remediation
window before public disclosure.

## Security boundaries

Security-sensitive behavior includes:

- shell-free executable invocation and cancellation of owned child processes;
- containment and validation of user-controlled paths;
- restrictive temporary report ownership and cleanup;
- bounded child output and strict jscpd report parsing;
- trusted-only project configuration reads;
- omission of source fragments and private process output from findings; and
- exclusion of local overrides, credentials, and private coding-agent context
  from Git history and npm packages.

The extension is advisory and installs jscpd only as an explicit package
dependency; it never downloads packages during a Pi session, rewrites project
configuration, edits source automatically, or treats scan success as permission
to publish data. Security fixes must preserve those boundaries.

The completed [Effect architecture](docs/effect-architecture.md) preserves and
strengthens resource ownership. Child-process, temporary-report, and bounded
filesystem resources now use typed Effect services and scoped file/process
ownership. Baseline, changed-file, acknowledgement, verification, and session
snapshot state now use generation/revision-checked Effect owners with bounded
values. Automatic scheduling uses scoped fibers, interruption-linked abort
signals, and acknowledgement commit only after successful quiet delivery.
Scan, changed, status, and Fallow application workflows compose these typed
services without nested Promise error handling; bounded public failures remain
the only operational output. Trusted configuration, report paths, clone source
ranges, and Fallow signals retain no-follow, containment, and byte-limit checks.
The Pi host owns one managed runtime; cancellation interrupts native command
fibers and shutdown awaits tracked baseline plus bounded scheduler, process, and
workspace finalizers before closing its layer scope. The source conformance audit
restricts Promise workflows to reviewed Pi/TUI and filesystem infrastructure
boundaries and found no unmanaged service runtimes. Final supported-host,
dependency/security, and packed-artifact recertification passes on the unreleased
branch. Migration must not turn defects or sensitive exception details into
user-facing output.

## Release authority

Only [Revaz Zakalashvili](https://github.com/revazi) may authorize an npm
publication or security release. A pull request, automated dependency update,
CI result, readiness run, Effect migration completion, or third-party review
does not itself authorize a release. If a vulnerability affects a future published version, coordinate any
deprecation, corrected release, advisory, and bounded post-release verification
privately before disclosure; npm versions must never be overwritten.
