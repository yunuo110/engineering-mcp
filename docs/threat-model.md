# Threat Model

## Scope

Engineering MCP is a safety-first control plane for native coding-agent harnesses. It is **not** an OS sandbox.

## Trust boundaries

- The MCP host / OWNER is trusted to create tasks and own lifecycle decisions.
- The local operator is trusted to configure Engineering MCP and Harness executables.
- Native Harnesses are trusted to perform coding work, but they do **not** own Engineering MCP lifecycle state.
- Provider/model authentication belongs to each Harness; Engineering MCP does not store provider credentials.

## Risks

### Harness execution is not sandboxed

External Harnesses run with the user's OS permissions. A Harness may intentionally or accidentally modify files outside the repository, read user data, or launch other processes. Engineering MCP does not prevent this.

Mitigations:

- task text cannot control executable/argv through `GenericCliAdapter`;
- manifests are declarative and shell-free;
- the Runner verifies Git HEAD, changed files, allowed scope, and forbidden scope after execution;
- recovery is explicit and OWNER-only.

### Worker testimony is not authority

A Harness result is not proof that repository state is safe. The trusted Worker Runner independently verifies Git and records the outcome.

### Lifecycle state tampering

Task status, execution instance, writer generation, and dispatch state are stored in a SQLite ledger with constraints, triggers, and fencing. A Harness should not be able to alter ledger state directly.

### Credentials and secrets

Engineering MCP must not:

- store provider API keys;
- implement provider login;
- proxy credentials;
- persist Harness auth tokens in the ledger;
- include real credentials in examples, tests, or docs.

Authentication belongs to each Harness.

## Control mechanisms

- persistent task lifecycle;
- one RUNNING slot;
- execution-instance ownership;
- writer-generation fencing;
- repository binding;
- HEAD verification;
- allowed/forbidden scope verification;
- explicit recovery;
- fail-closed worker protocol.

## Out of scope

- OS-level sandboxing;
- remote runner security;
- multi-tenant cloud isolation;
- malicious Harness defense beyond post-hoc Git verification.
