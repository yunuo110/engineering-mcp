# Engineering MCP

A repository-aware AI engineering control plane for coordinating trusted coding workers through the Model Context Protocol (MCP).

Engineering MCP lets an OWNER delegate bounded engineering work to trusted worker Harnesses while keeping repository ownership, task lifecycle, execution authority, and verification under explicit control.

It is designed around one principle:

> **Workers perform bounded execution. The control plane owns engineering state.**

Engineering MCP is **not** a model router. It does not let task text choose arbitrary providers, models, executables, manifests, or credentials. Instead, it provides the coordination and safety layer around native coding-agent Harnesses.

## Why Engineering MCP?

Coding agents are good at implementation, but reliable multi-agent engineering needs more than simply sending prompts to another model.

Engineering MCP provides:

- repository-bound task management;
- controlled Worker delegation;
- persistent task and dispatch lifecycle;
- trusted Worker Profile selection;
- Worker result validation;
- Git HEAD and scope verification;
- explicit recovery and cancellation;
- durable execution records;
- compatibility with native and Generic CLI Harnesses.

Engineering truth remains in durable project state — the repository, Git history, tests, and Engineering MCP ledger — rather than depending on temporary conversation history.

## Quick Start

Requires Node.js 24 or newer and Git on PATH. The repository must have an initial
commit. Creating, claiming, and resuming tasks requires a clean working tree on a
named branch. Install and authenticate the selected Harness separately; installing
Engineering MCP does not install or authenticate Codex or another Harness.

Install from npm:

```bash
npm install -g engineering-mcp-cli
```

Verify the CLI:

```bash
engineering-mcp --help
```

From inside a Git repository, start an OWNER server:

```bash
cd /path/to/repository
engineering-mcp --role owner
```

Engineering MCP automatically resolves the repository from the current Git working tree unless an explicit repository is configured.

Useful commands:

```bash
engineering-mcp setup
engineering-mcp doctor
engineering-mcp profiles --worker-profiles /absolute/path/to/profiles.yaml
```

For local development from this repository:

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

## How It Works

```text
MCP Host / OWNER
        |
        v
Engineering MCP
lifecycle | ledger | repo safety
        |
        v
Trusted Worker Runner
        |
        v
Native Harness Adapter
        |
        v
Harness-managed Provider / Model
```

The OWNER controls engineering state and delegation.

Engineering MCP controls lifecycle, repository binding, dispatch ownership, recovery, and verification.

The Worker Runner executes the selected trusted Harness configuration.

The Harness remains responsible for its own model/provider behavior, agent loop, tools, and execution strategy.

## Harness-Native Execution Principle

Engineering MCP standardizes **WHAT**:

- task contracts;
- lifecycle ownership;
- repository binding;
- Git verification;
- dispatch state;
- final Engineering Worker Protocol result contracts.

Native Harnesses decide **HOW**:

- reasoning strategy;
- tool use;
- context management;
- model/provider selection;
- agent-loop behavior;
- execution strategy.

In short:

> **Engineering MCP standardizes WHAT, not HOW.**

Engineering MCP is not a universal model API, replacement Harness, autonomous scheduler, or provider router.

## OWNER Workflow

An OWNER process creates engineering tasks, selects trusted Worker Profiles, delegates execution, waits for terminal results, and handles recovery or cancellation when needed.

Core OWNER tools include:

- `create_task`
- `get_task`
- `list_active_tasks`
- `list_worker_profiles`
- `delegate_task`
- `await_delegation`
- `recover_task`
- `resume_task`
- `cancel_task`
- `close_task`

A typical automated handoff looks like:

```text
OWNER
  |
  v
create_task
  |
  v
READY
  |
  v
delegate_task
  |
  v
Worker Runner
  |
  v
Native Harness
  |
  v
validated EWP result
  |
  v
Git / scope verification
  |
  v
COMPLETED or BLOCKED
  |
  v
OWNER handback
```

Harnesses do not own Engineering MCP lifecycle state.

## Worker Profiles

Worker Profiles are trusted operator configuration for selecting preconfigured Harness execution modes.

They are loaded once at process startup and remain immutable for the lifetime of that Engineering MCP process.

Example:

```yaml
schema: engineering-worker-profiles/1

default_profile: codex-luna

profiles:
  codex-luna:
    adapter: codex-exec-luna
    description: Codex CLI worker

  my-generic-worker:
    adapter: generic-cli
    manifest: /absolute/path/to/trusted/manifest.yaml
    profile: production
    model: worker-model
    description: My trusted Generic Harness
```

Start Engineering MCP with a profile registry:

```bash
engineering-mcp --role owner \
  --worker-profiles /absolute/path/to/profiles.yaml
```

The OWNER can inspect available profiles with:

```text
list_worker_profiles
```

and select one during delegation:

```text
delegate_task(worker_profile = "my-generic-worker")
```

Conceptually:

```text
OWNER
  |
  v
worker_profile = "my-generic-worker"
  |
  v
trusted startup-loaded registry
  |
  v
adapter + immutable Harness configuration
  |
  v
Worker Runner
  |
  v
native Harness
```

Without an external profile file, Engineering MCP uses the built-in:

```text
codex-luna
→ codex-exec-luna
```

default.

Worker Profiles do **not** let task text choose arbitrary:

- executables;
- argv;
- manifest paths;
- models;
- providers;
- endpoints;
- credentials;
- shell commands.

For Generic CLI workers, the trusted manifest is validated and captured at startup. Later changes to the original manifest file do not change execution for the already-running OWNER process.

See [Worker Profiles](docs/worker-profiles.md).

## Generic CLI Adapter

`GenericCliAdapter` connects Engineering MCP to local coding-agent Harnesses through declarative `engineering-cli-adapter/1` manifests.

A manifest defines trusted execution configuration such as:

- command;
- arguments;
- working directory;
- prompt transport;
- result transport;
- process behavior.

Task text cannot select the executable or arbitrary argv.

Validate a manifest:

```bash
engineering-mcp adapter validate manifest.yaml
```

Probe local Harness availability:

```bash
engineering-mcp adapter probe manifest.yaml
```

`adapter probe` validates the manifest and performs a bounded local availability/version check. It does not perform an authenticated model smoke.

Real Harness execution remains explicit.

## Engineering Worker Protocol

Engineering MCP uses the Engineering Worker Protocol:

```text
engineering-worker/1
```

EWP defines the Harness-independent task and terminal-result contract.

It includes engineering information such as:

- task goal;
- allowed and forbidden scope;
- acceptance criteria;
- validation requirements;
- repository root;
- base commit;
- Worker role;
- terminal outcome;
- changed files;
- validation results;
- known limitations.

EWP intentionally does **not** contain:

- Worker Profile IDs;
- provider configuration;
- model-routing authority;
- arbitrary executables;
- manifests;
- credentials;
- Engineering MCP lifecycle ownership.

Worker Profile selection belongs to trusted orchestration configuration, outside EWP.

See [Engineering Worker Protocol](docs/engineering-worker-protocol.md).

## Automatic Repository Binding

The default public startup is:

```bash
engineering-mcp --role owner
```

Repository resolution precedence:

```text
1. --repo
2. ENGINEERING_MCP_REPO
3. launch cwd → git rev-parse --show-toplevel
4. fail closed
```

Properties:

- launching from a repository subdirectory resolves to the Git root;
- linked worktrees resolve to their own worktree roots;
- starting outside Git fails with `REPOSITORY_NOT_FOUND`;
- repository binding is immutable after startup;
- failed repository discovery does not open a ledger.

Engineering MCP is intentionally bound to one repository for the lifetime of a process.

## Safety Model

Engineering MCP is **not an operating-system sandbox**.

Trusted Harnesses execute with the permissions of the local user.

Engineering MCP instead provides control-plane safety around engineering execution:

- persistent task lifecycle;
- repository binding;
- Git HEAD verification;
- allowed-scope verification;
- forbidden-scope verification;
- execution-instance ownership;
- current-writer fencing;
- dispatch ownership;
- explicit recovery;
- fail-closed Worker protocol validation;
- independent Git verification by the trusted Worker Runner.

Worker testimony is not Git authority.

The Runner independently verifies repository state after execution.

Ignore rules do not exempt files from task scope. The Runner compares ignored
files immediately before and after Harness execution, alongside ordinary Git
changes. Net additions, content/permission changes, link-target changes and
deletions must match an allowed path or directory prefix and must not match a
forbidden path or prefix. Unchanged ignored artifacts and timestamp-only changes
are not reported. Worker-reported filenames are not used as scope authority.
Tasks that generate ignored build/cache output must allow those output paths.
Other repository writers must be quiescent during execution; this comparison
observes net changes, not which OS process made them.

This requires two content-hashing passes over ignored regular files, including
caches; large ignored trees add work proportional to their total bytes. Reads use
bounded buffers, and symlinks are observed without following their targets.
Unreadable entries, opaque nested repositories, special files, or an ignored-path
listing exceeding 64 MiB fail verification rather than permit completion. This is
a before/after check, not a record of transient writes that are fully reverted,
and it does not monitor writes outside the repository.

### Current-Writer Fencing

The persistent ledger uses a versioned writer protocol.

Current writer fencing protects mutable engineering state including:

```text
tasks
dispatch_runs
task_events
```

A process using an incompatible previous writer protocol cannot continue mutating a migrated current ledger, including through an already-open SQLite connection.

## Recovery

Recovery is explicit and OWNER-controlled.

If a Worker Runner disappears or an active dispatch becomes orphaned, the OWNER can use recovery operations to terminate the active dispatch state and return the task to a safe delegable state.

`cancel_task` similarly terminates active dispatch state when cancelling work.

Engineering MCP does not silently invent successful Worker outcomes during recovery.

`cancel_task` and `recover_task` revoke ledger execution authority; they do not kill
the Harness or its child processes. Stop the old Harness process tree and inspect
the working tree before recovery, cancellation followed by new work, or resuming.
Otherwise the old process retains filesystem access while the ledger slot is free.
Wait timeouts and MCP disconnects are not worker execution timeouts.

If startup was interrupted after dispatch persistence but before task claim, the
task remains `READY` with an active dispatch. Cancel it and create a replacement
after stopping the old processes. `recover_task` accepts only `RUNNING` tasks.

On Windows, the Codex `.cmd` fallback rejects paths containing `%`, `!`, quotes,
or newlines. Use a native `codex.exe` launcher for those paths.

## Verified Compatibility

Support labels are intentionally conservative.

### Hosts

| Host | Support |
| --- | --- |
| Grok CLI | `REAL HOST STARTUP / HANDSHAKE / TOOL DISCOVERY` |
| Codex CLI | `MCP STARTUP / AUTO-REPO TEST COVERAGE — CODEX HOST E2E NOT VERIFIED FOR THIS RELEASE` |

The release hardening check used real Grok CLI `1.0.24` with an installed package
in a temporary trusted project: the server started, negotiated MCP `2025-11-25`,
and exposed ten OWNER tools. This check does not establish authenticated model
execution or a real-host Worker handoff for 0.1.1.

Automatic repository discovery is exercised with a spawned startup fixture
([auto-binding regression](test/repository-auto-binding.test.ts)); MCP startup
and handshakes are exercised with a generic client
([packaged-consumer regression](test/packed-delegate-task.test.ts)). Neither
establishes a real Codex-host E2E session for this release.

### Worker Harnesses

| Worker Harness | Support |
| --- | --- |
| Codex CLI + GPT-5.6 Luna | `CONTROLLED PROCESS TESTS — AUTHENTICATED MODEL E2E NOT VERIFIED` |
| GenericCliAdapter | `CONTROLLED HARNESS / PACKAGED MCP FLOW TESTED` |
| DSH + DeepSeek V4 Flash Max | `HISTORICAL INTEGRATION — NOT REVALIDATED FOR 0.1.1` |

Codex worker evidence in this release covers process invocation and Windows `.cmd`
wrapper behavior using a controlled local Harness
([process regression](test/release-codex-process.test.ts)), plus registry and
packaged Worker Runner execution with a deterministic Codex stub
([registry regression](test/codex-registry-integration.test.ts),
[packaged-consumer regression](test/packed-delegate-task.test.ts)). These tests do
not authenticate to or execute GPT-5.6 Luna. No traceable authenticated Codex model
E2E artifact is included for this release. Host/client test coverage above is
separate from worker-model verification.

Generic MCP coverage includes initialization, tool discovery, argument validation,
controlled Harness execution, durable restart, and scope enforcement through an
installed tarball. The validation platform for 0.1.1 is Windows with Node.js 24;
Linux/macOS runtime validation is not claimed.

The earlier DSH integration report used DSH `0.1.2-rc.1` through a trusted
bridge/wrapper. That integration was not rerun for 0.1.1.

The documented DSH integration is:

```text
Engineering MCP
  |
  v
GenericCliAdapter
  |
  v
trusted DSH bridge
  |
  v
DSH
  |
  v
DSH-managed provider/model path
```

Engineering MCP integrates DSH as a Harness. It does **not** claim direct DeepSeek API integration.

See [DSH Harness Example](examples/harnesses/dsh/README.md).

### Community / Unverified

| Harness | Label |
| --- | --- |
| Claude Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Qwen Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Kimi Code | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |
| Other Harnesses | `COMMUNITY RECIPE — NOT MAINTAINER E2E VERIFIED` |

## Support Tiers

- **VERIFIED** — maintainer real authenticated E2E.
- **VERIFIED CORE** — the core integration mechanism has real E2E evidence, but not every third-party Harness.
- **COMMUNITY** — configuration or integration recipe exists without maintainer authenticated E2E.
- **EXPERIMENTAL** — evidence exists, but the upstream interface is unstable or pre-release.
- **PLANNED** — not implemented or not validated.

## Current Scope

Engineering MCP currently focuses on controlled, repository-bound engineering workflows.

Current scope intentionally includes:

- one RUNNING task slot;
- sequential Worker execution;
- explicit OWNER lifecycle control;
- local Worker Runner processes;
- trusted local Harness execution.

It currently does **not** provide:

- autonomous scheduling;
- parallel RUNNING tasks;
- automatic commits or merges;
- remote Worker infrastructure;
- cloud-hosted execution;
- model/provider routing;
- a web UI;
- a heartbeat/lease subsystem.

These are scope boundaries, not implicit execution authority.

## Documentation

- [Architecture](docs/architecture.md)
- [Engineering Worker Protocol](docs/engineering-worker-protocol.md)
- [Worker Profiles](docs/worker-profiles.md)
- [Adapter Authoring](docs/adapter-authoring.md)
- [Host Setup](docs/host-setup.md)
- [Threat Model](docs/threat-model.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The public package is built from `dist/`.

## License

Apache-2.0.
