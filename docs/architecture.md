# Architecture

Engineering MCP is a local control plane between MCP hosts and native coding-agent harnesses.

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

## Components

### Public CLI (`engineering-mcp`)

The `src/cli.ts` executable provides:

- `engineering-mcp --help`
- `engineering-mcp --role owner|junior|principal`
- `engineering-mcp setup`
- `engineering-mcp doctor`
- `engineering-mcp profiles`
- `engineering-mcp adapter validate <manifest>`
- `engineering-mcp adapter probe <manifest>`

The `--role` path preserves the existing MCP server startup behavior with runtime-aware entry resolution: source/dev execution spawns `src/index.ts`, and built/package execution spawns `dist/index.js`.

### Repository resolver

Repository resolution precedence:

1. `--repo`
2. `ENGINEERING_MCP_REPO`
3. `process.cwd()` → `git rev-parse --show-toplevel`
4. fail closed with `REPOSITORY_NOT_FOUND`

The resolved repository is immutable for the process lifetime.

### Ledger

The SQLite ledger stores tasks, append-only task events, immutable-checkpoint provenance, dispatch runs, and repository binding metadata. It is persisted outside the repository under the user data directory by default. Ledger paths are deterministic per repository root and are never included in source control.

### Store and lifecycle

The Store owns:

- persistent FIFO-style task queue (READY → RUNNING → terminal states);
- one `RUNNING` task invariant;
- execution-instance ownership;
- writer-generation fencing;
- schema migrations;
- repository binding validation.

Dirty implementation handoff is explicit. `checkpoint_task` accepts only purpose-compatible
terminal implementation tasks, rejects Git-visible changes outside the task scope and every
changed gitlink, and records a durable intent before Git mutation. The prepared operation converges
through Git application and ledger finalization to one immutable commit/ref identity. It never uses
stash, reset, or discard. A `RESUME` checkpoint becomes the task's recovery baseline; a `REVIEW`
checkpoint is consumed only by `create_diagnosis_from_checkpoint`, which persists the producer and
checkpoint linkage on the diagnosis task.

Schema V8 uses a `+3` writer-generation protocol. Database triggers reject the legacy V7 `+2`
mutation pattern even from a connection opened before migration, and an unfinished checkpoint
intent fences task and dispatch lifecycle mutation for the entire repository. The only mutating
exception is the exact producer/revision/request retry required to finalize that intent.

Targeted workers use `inspect_claimable_task` to obtain a minimal claim ticket. Payload visibility
does not expand until `claim_task` succeeds. Optimistic revision and all repository/role checks are
still enforced by the atomic claim.

### Trusted Worker Runner

The Worker Runner:

- claims a task from the ledger;
- verifies repository root, branch, HEAD, and clean baseline;
- creates a dispatch run;
- invokes the configured Harness adapter;
- validates the returned Engineering Worker Protocol result;
- records results and failures in the ledger;
- never allows task text to control executable/argv.

### Adapters

Two adapter categories exist:

- specialized native adapters, such as `CodexExecAdapter`;
- `GenericCliAdapter`, driven by declarative `engineering-cli-adapter/1` manifests.

Adapters are registered in `src/adapters/registry.ts`.

### Worker Profiles

Worker Profiles are trusted operator configuration loaded once at MCP process startup. The OWNER selects a profile by ID through `delegate_task(worker_profile = "...")` or lists them through `list_worker_profiles`.

The registry maps a profile ID to:

- adapter;
- manifest (for GenericCliAdapter);
- opaque Harness `profile` and `model` strings.

Worker Profiles are immutable after startup. They do **not** allow task text to choose arbitrary executables, manifest paths, providers, models, or credentials. Without a profile file, Engineering MCP uses the built-in `codex-luna` profile.

### Engineering Worker Protocol

`engineering-worker/1` is the canonical request/result contract between Engineering MCP and a Worker Harness. Requests contain task and repository context only. Results are terminal and must not contain request-envelope fields. Worker Profile selection is outside EWP.

## Safety boundaries

- Engineering MCP is not an OS sandbox.
- Harnesses run with the user's OS permissions.
- Worker testimony is not Git authority; the Runner independently verifies Git.
- Lifecycle authority remains inside Engineering MCP.
