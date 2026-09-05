# Contributing

Thanks for contributing to Engineering MCP.

## Development setup

```bash
npm ci
npm run typecheck
npm test
git diff --check
```

## Public release principles

- Do not weaken lifecycle ownership, execution-instance fencing, writer-generation fencing, or Git verification.
- All normal tests must remain offline.
- Normal tests/setup/doctor must never consume model quota.
- Authenticated Harness smoke tests must be explicitly opt-in and must never run in CI.

## Adding a Harness

- Prefer a declarative `engineering-cli-adapter/1` manifest with `GenericCliAdapter`.
- Only add a specialized adapter when the Harness materially requires it.
- Community manifests must be labeled as `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED`.
- Never include real credentials, tokens, private endpoints, or personal paths in examples, tests, or docs.

## Pull request checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm pack` succeeds and the packed artifact is usable.
- [ ] No secrets or private artifacts are added.
- [ ] Documentation is updated if user-facing behavior changes.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
