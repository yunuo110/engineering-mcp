# Security

Engineering MCP is a local control plane for native coding-agent harnesses.

## Not an OS sandbox

Engineering MCP is **not** an OS sandbox. Trusted operator configuration can intentionally launch local Harness executables. External Harnesses run with the user's OS permissions.

## Control mechanisms

Engineering MCP includes:

- persistent task lifecycle;
- one RUNNING slot;
- execution-instance ownership;
- writer-generation fencing;
- repository binding;
- HEAD verification;
- allowed/forbidden scope verification;
- explicit recovery;
- fail-closed worker protocol.

Worker testimony is not Git authority. The Runner independently verifies Git state.

## Credentials

Engineering MCP does not store provider API keys, implement provider login, proxy credentials, or persist Harness auth tokens in the ledger. Authentication belongs to each Harness.

## Sensitive data

Do not commit:

- API keys, auth tokens, bearer strings;
- `.env` files;
- local ledger SQLite files;
- logs;
- backups;
- private manifests;
- model/provider logs;
- private endpoints or personal paths.

## Reporting vulnerabilities

If you find a security issue, open a private issue or contact the maintainers with a minimal reproduction. Do not include live credentials in the report.

## Scope

This project is provided under the Apache License 2.0. See [LICENSE](LICENSE).
