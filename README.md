# Engineering MCP

**Engineering MCP is a safety-first control plane for native coding-agent harnesses.**

It does not replace a model provider, agent loop, Harness, or scheduler. Engineering MCP coordinates a small set of local coding-agent Harnesses through a narrow Engineering Worker Protocol (EWP/1) while keeping lifecycle authority and repository safety inside the control plane.

## Architecture

```text
MCP Host / OWNER
       ↓
Engineering MCP
lifecycle · ledger · repo safety
       ↓
Trusted Worker Runner
       ↓
Native Harness Adapter
       ↓
Harness-managed Provider / Model
```

## Harness-Native Execution Principle

Engineering MCP standardizes:

- `WHAT must be done` (task contract)
- lifecycle ownership
- repository binding and Git verification
- final Engineering Worker Protocol result contract

Native Harnesses decide:

- `HOW to reason`
- tool use
- context management
- model/provider selection
- execution strategy

Engineering MCP is **not** a model router, universal model API, replacement Harness, or autonomous scheduler.

## Quick start

```bash
npm install -g engineering-mcp-cli

engineering-mcp --help
engineering-mcp setup
engineering-mcp doctor
```

From inside a Git repository, start an OWNER server:

```bash
cd /path/to/repo
engineering-mcp --role owner
```

For local development from this repository:

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

## Verified capability matrix

### Hosts

| Host | Support |
| --- | --- |
| Grok CLI | `VERIFIED` |
| Codex CLI | `VERIFIED FOR MCP STARTUP / AUTO-REPO` |

Grok CLI evidence includes real MCP OWNER use, cwd/subdirectory behavior, automatic repository binding, and real worker handoff. Codex CLI is verified for MCP startup and automatic repository discovery; do not treat broader Codex host scenarios as verified unless explicitly tested.

### Worker Harnesses

| Worker Harness | Support |
| --- | --- |
| Codex CLI + GPT-5.6 Luna | `VERIFIED` |
| GenericCliAdapter | `VERIFIED CORE` |
| DSH + DeepSeek V4 Flash Max | `VERIFIED / EXPERIMENTAL UPSTREAM CAVEAT` |

DSH evidence is real Engineering MCP E2E against DSH `0.1.2-rc.1` through a trusted DSH bridge/wrapper. Engineering MCP integrates DSH as the Harness and does **not** claim direct DeepSeek API integration. See `examples/harnesses/dsh/README.md` for the verified architecture reference.

### Community / unverified

| Harness | Label |
| --- | --- |
| Claude Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Qwen Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Kimi Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Other Harnesses | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |

## Automatic repository binding

Default public story:

```text
engineering-mcp --role owner
```

Resolution precedence:

```text
1. --repo
2. ENGINEERING_MCP_REPO
3. launch cwd → git rev-parse --show-toplevel
4. fail closed
```

Properties:

- a repo subdirectory resolves to the Git root;
- a linked worktree resolves to its own worktree root;
- outside Git fails with `REPOSITORY_NOT_FOUND`;
- binding is immutable after process startup;
- no ledger is opened on failed auto-discovery.

## OWNER workflow

An OWNER process creates tasks, delegates to a Worker Harness, awaits the terminal result, and can recover or cancel a stuck task. The Worker Runner owns claim-time repository checks, process execution, result schema validation, and Git verification.

Core OWNER tools include:

- `create_task`
- `get_task`
- `list_active_tasks`
- `delegate_task`
- `await_delegation`
- `recover_task`
- `resume_task`
- `cancel_task`
- `close_task`

## Worker Harnesses

Workers claim tasks through the trusted Worker Runner. Harnesses never own Engineering MCP lifecycle state. A Harness may be a native adapter (for example Codex CLI) or a declarative Generic CLI adapter.

## GenericCliAdapter

`GenericCliAdapter` executes a local Harness from a declarative `engineering-cli-adapter/1` manifest. Manifests are shell-free: command, arguments, working directory, prompt transport, and result transport are explicit. Task text cannot select executables or argv.

Use:

```bash
engineering-mcp adapter validate manifest.yaml
engineering-mcp adapter probe manifest.yaml
```

`adapter probe` validates the manifest and then runs the equivalent of `<command> --version` with a bounded timeout and local execution only. It does not invoke a model or perform an authenticated smoke. `adapter smoke`, if exposed, is explicitly opt-in and may consume model quota.

## Safety model

Engineering MCP is **not** an OS sandbox.

Trusted operator configuration can intentionally launch local Harness executables. External Harnesses run with the user's OS permissions. Engineering MCP control mechanisms include:

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

## Recovery

Recovery is explicit and OWNER-only. If a Worker Runner disappears or a dispatch becomes orphaned, `recover_task` terminates the active dispatch atomically and returns the task to a delegable state. `cancel_task` performs a similar termination for cancellation.

## Support tiers

- **VERIFIED** — maintainer real authenticated E2E.
- **VERIFIED CORE** — core mechanism has real E2E evidence, but not every third-party Harness.
- **COMMUNITY** — recipe/config exists but maintainer has no authenticated E2E.
- **EXPERIMENTAL** — evidence exists but upstream interface is unstable/developer-preview.
- **PLANNED** — not implemented or not validated.

## Limitations

- one RUNNING task slot;
- no autonomous scheduler;
- no parallel RUNNING;
- no auto commit/merge;
- no remote runners or cloud service;
- no provider router;
- no web UI;
- no heartbeat/lease subsystem yet.

## Contribution / docs

See:

- [Architecture](docs/architecture.md)
- [Engineering Worker Protocol](docs/engineering-worker-protocol.md)
- [Adapter Authoring](docs/adapter-authoring.md)
- [Host Setup](docs/host-setup.md)
- [Threat Model](docs/threat-model.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
