## Summary

- 

## Validation

- [ ] `npm run docs:check`
- [ ] `npm run repo:hygiene`
- [ ] `npm run check`
- [ ] `npm run pack:certify` when package contents, metadata, host behavior, or release policy may change
- [ ] `npm run pack:dry-run` when package contents or metadata may change
- [ ] Relevant Pi smoke test for lifecycle, command, tool, or UI changes
- [ ] No network-dependent test was added

## Safety and compatibility

- [ ] The change remains advisory, read-only, bounded, and fail open
- [ ] jscpd remains the duplication authority
- [ ] No private agent context, local override, credential, source fragment, or generated report is included
- [ ] User-visible behavior, compatibility, and release-status claims are documented
- [ ] No version, tag, publication credential, or release activation was added without explicit maintainer approval
- [ ] A durable decision is called out when public names, configuration, persistence, process ownership, or release authority change

Closes #
