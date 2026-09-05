# AI_PROJECT_STATE.md

## Current Phase

**Goal**

Engineering MCP V1.6 is a local stdio coordination ledger with a persistent FIFO queue, explicit execution ownership, and fail-closed manual recovery.

**Status**

V1.6 is implemented: server startup is execution-state side-effect free, RUNNING tasks are owned by specific server execution instances, SQLite triggers enforce execution ownership against legacy writers, migration refuses legacy RUNNING state, explicit OWNER recovery is revision-protected and repository-bound, and each ledger is bound to one canonical repository.

**Next**

Independent acceptance review of V1.6. Do not add heartbeat/lease, automatic recovery, or worker supervision yet.

---

## Current Architecture Snapshot

- Launch: `node src/index.ts --role owner|junior|principal --repo <target> [--db <path>]`. Role is process identity, not a tool argument.
- Each MCP server process generates a cryptographically random `execution_instance_id` that lives for the process/instance lifetime.
- Transport: local stdio via `@modelcontextprotocol/server` v2 `serveStdio`.
- Persistence: `node:sqlite` (`DatabaseSync`) with WAL, foreign keys, 5s busy timeout, and `user_version = 6`.
- Tables: `tasks` (authoritative), `task_events` (audit only), and `ledger_metadata` (repository binding).
- SQLite triggers enforce the execution-state invariant: `RUNNING` must have `execution_instance_id`, and non-`RUNNING` must not have one.
- SQLite triggers also enforce `task.repo_root == ledger_metadata.repository_root`, reject arbitrary `RUNNING → RUNNING` task mutations, and require every current task write to carry/advance a `writer_generation`.
- After migration, legacy V1 connections cannot INSERT or UPDATE tasks; reads remain governed by existing permissions.
- A ledger is bound to exactly one canonical repository. Opening a ledger from a different repository fails closed.
- Tasks include `assignee_role` (authorization/assignment) and `execution_instance_id` (active execution ownership).
- `claim_task` / `claim_next_task` atomically transition `READY → RUNNING` and store the claiming server instance as execution owner.
- Server startup never recovers RUNNING tasks. A stale RUNNING task remains RUNNING until an OWNER explicitly calls `recover_task`.
- `recover_task` is OWNER-only, task-specific, revision-protected, repository-bound, and transitions `RUNNING → BLOCKED` while clearing execution ownership.
- Git access is read-only (`rev-parse`, `status --porcelain=v1`). `create_task` / `claim_task` / `claim_next_task` / `resume_task` require a clean tree; claims also require matching branch and `HEAD === base_commit`.
- Retry/requeue remains explicit through owner `resume_task`; V1.6 does not automatically retry.
- OWNER may call `delegate_task` to start a trusted Worker Runner, which claims as JUNIOR and runs a configured worker adapter.

---

## Confirmed Invariants

These are enforced by code and tests:

- `create_task` lands in `READY`; there is no durable `CREATED` state.
- `claim_task` and `claim_next_task` are the only transitions into `RUNNING`.
- At most one `RUNNING` task exists per ledger, enforced by code and the SQLite partial unique index.
- Pending queue order is deterministic: FIFO by `created_at ASC, rowid ASC`.
- Server startup is execution-state side-effect free; it never recovers RUNNING tasks.
- A RUNNING task is owned by the specific server/execution instance that claimed it, not merely by its assignee role.
- Same-role but different-instance workers cannot mutate a RUNNING task through `report_result` / `report_blocked`.
- `report_result` / `report_blocked` from the owning instance release the RUNNING slot and clear execution ownership.
- Explicit recovery requires task id + expected revision, validates repository binding, and only transitions RUNNING → BLOCKED.
- `resume_task` reopens `BLOCKED` | `FAILED` | `COMPLETED` to `READY`, clears assignee/result/blocker/execution ownership, and captures current HEAD as `base_commit`.
- Workers cannot read `READY` tasks; a successful `claim_task` / `claim_next_task` returns the full Task Contract.
- JUNIOR claims only IMPLEMENTATION; PRINCIPAL claims only DIAGNOSIS.
- Mutating lifecycle ops are transactional (revision check, status check, row update, event insert).
- The MCP does not mutate Git state.
- A task remains bound to the canonical `repo_root` captured at create. Claim/resume/recovery operations reject a process bound to a different repository.

---

## Known Risks / Transitional State

- `node:sqlite` is still experimental on Node.js 24.13.1. Isolated behind `store.ts`.
- SDK input-schema failures (for example extra `branch` on `create_task`) return MCP `isError` text from the SDK, not this server's `{ ok: false, error: { code } }` envelope. Domain errors from lifecycle do return structuredContent.
- `.gitignore` excludes `node_modules/` and `*.sqlite*`. The live ledger must not be committed.
- Connected Automations `tasks` MCP remains unrelated.
- If a worker crashes, its task remains RUNNING until an OWNER explicitly recovers it. This is intentional fail-closed behavior; V1.6 does not infer worker death from startup.
- V1/V1.5.x databases are migrated to schema version 6 by adding `execution_instance_id`, `writer_generation`, `ledger_metadata`, execution-fencing triggers, repository-fencing triggers, RUNNING-mutation fencing, writer-protocol fencing, and `dispatch_runs` orchestration persistence without destructive resets.
- If a legacy DB contains a `RUNNING` task, migration fails closed with `LEGACY_RUNNING_TASK_PREVENTS_MIGRATION`.

---

## Open Project-Level Questions

None that block V1.6 use. Automatic dead-worker detection requires future heartbeat/lease/fencing support and remains out of scope.
