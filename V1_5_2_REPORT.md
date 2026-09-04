# Engineering MCP V1.5.2 — Legacy Writer Fencing & Migration Hardening Report

## A. What changed

Implemented the V1.5.2 safety patch:

- Added SQLite database-level execution-state invariants:
  - `RUNNING` must have a non-null `execution_instance_id`;
  - non-`RUNNING` must have `execution_instance_id = NULL`.
- Added BEFORE INSERT and BEFORE UPDATE triggers on `tasks` so the invariant is enforced by SQLite, not only by TypeScript lifecycle code.
- Migration from older schema versions now fails closed if a legacy `RUNNING` task exists.
- Migration without a legacy `RUNNING` task proceeds safely and installs execution-fencing triggers.
- Opening a schema v2/v3 database validates that required execution-fencing triggers exist.
- Added real mixed-version tests using an extracted V1 process from commit `6b38cf4`.
- Updated authoritative docs to remove conflicting automatic-startup-recovery language.
- No new orchestration features, heartbeat, lease, scheduler, worktree, or parallel execution were added.

## B. Database fencing design

The database now enforces the following logical invariant:

```text
status = RUNNING
→ execution_instance_id IS NOT NULL

status != RUNNING
→ execution_instance_id IS NULL
```

This is implemented by two triggers:

- `trg_tasks_execution_invariant_insert`
- `trg_tasks_execution_invariant_update`

Both raise:

```text
EXECUTION_STATE_INVARIANT_VIOLATION
```

when a write would create or commit an invalid state.

Valid examples:

```text
READY/null
→ RUNNING/current-owner
→ COMPLETED/null
```

Invalid examples that are rejected atomically:

```text
READY/null
→ RUNNING/null                     -- rejected
RUNNING/current-owner
→ COMPLETED/current-owner          -- rejected
RUNNING/current-owner
→ BLOCKED/current-owner            -- rejected
```

## C. Migration behavior

### Legacy DB with no RUNNING task

```text
What happens?
Migration may proceed.
```

- Adds `execution_instance_id` if missing.
- Adds `ledger_metadata` if missing.
- Installs execution-fencing triggers.
- Validates that no existing row violates the invariant.
- Updates `user_version` to schema v3.
- Existing task/event history is preserved.

### Legacy DB with RUNNING task

```text
What happens?
Migration is refused.
```

- Raises `LEGACY_RUNNING_TASK_PREVENTS_MIGRATION`.
- Does not alter schema or task data.
- Does not fabricate an execution owner.
- Does not automatically recover, block, fail, or requeue the legacy RUNNING task.
- The legacy execution must be resolved/stopped under the old version before migration.

## D. Legacy claim result

Actual mixed-version test result:

```text
Old V1 process attempts claim after V2 migration
→ rejected atomically
→ task remains READY
→ execution_instance_id remains NULL
→ no invalid RUNNING state is created
```

The old V1 process receives a database-level `EXECUTION_STATE_INVARIANT_VIOLATION` failure.

## E. Legacy result/block result

Actual mixed-version results:

```text
V2-owned RUNNING task
old V1 report_result
→ rejected atomically
→ task remains RUNNING
→ execution_instance_id unchanged
→ current owner can still complete the task

V2-owned RUNNING task
old V1 report_blocked
→ rejected atomically
→ task remains RUNNING
→ execution_instance_id unchanged
→ no contradictory event/history residue
```

## F. Legacy mutation audit

The meaningful old V1 task write paths were inspected:

| Old V1 path | Fenced? | Why |
|---|---|---|
| `createTask` insert READY | Safe | Non-RUNNING row with NULL owner is valid |
| `claimTask` READY → RUNNING | Fenced | Legacy update leaves owner NULL, rejected by trigger |
| `reportResult` RUNNING → COMPLETED/FAILED | Fenced | Legacy update leaves owner non-NULL, rejected by trigger |
| `reportBlocked` RUNNING → BLOCKED | Fenced | Legacy update leaves owner non-NULL, rejected by trigger |
| `cancelTask` RUNNING → CANCELLED | Fenced | Legacy update leaves owner non-NULL, rejected by trigger |
| `resumeTask` non-RUNNING → READY | Safe | Non-RUNNING task has NULL owner; resulting READY is valid |
| `closeTask` terminal → CLOSED | Safe | Non-RUNNING task has NULL owner; resulting CLOSED is valid |
| generic legacy `updateTask` | Fenced by invariant | Any invalid status/owner combination is rejected by trigger |

No remaining legacy execution-sensitive write path was found that can violate the ownership invariant.

## G. Schema changes

- Old schema version in this patch: v2 from the V1.5.1 work.
- New schema version: v3.
- Added database objects:
  - `tasks.execution_instance_id` (already present in v2; retained)
  - `ledger_metadata` (already present in v2; retained)
  - `trg_tasks_execution_invariant_insert`
  - `trg_tasks_execution_invariant_update`
- Migration transaction strategy:
  - v1/v2 migrations run inside `BEGIN IMMEDIATE`.
  - If a legacy RUNNING task is detected, the transaction rolls back.
  - `user_version` is only updated after all required triggers are installed.
- Backward compatibility:
  - Old task/event rows are preserved.
  - Legacy non-RUNNING databases migrate safely.
  - Legacy RUNNING databases fail closed.
  - Old processes already connected before migration are fenced by SQLite triggers.

## H. Audit integrity

Rejected legacy writes leave no task/event residue:

- The invalid task UPDATE is aborted by the trigger.
- Any surrounding transaction is rolled back by the old process's existing transaction handling.
- No contradictory audit event is committed.
- The task remains in its previous valid state.

## I. Documentation consistency

Automatic startup recovery language has been removed/superseded.

Current authoritative docs now state:

- Server startup has zero execution-state recovery side effects.
- A crashed/lost execution remains RUNNING.
- Only OWNER may explicitly recover a specific RUNNING task.
- Recovery requires:
  - task id;
  - expected revision;
  - repository match.
- Recovery transitions:
  - `RUNNING → BLOCKED`
  - with `CONTEXT_STALE` and structured recovery metadata.

The old V1.5 automatic OWNER/JUNIOR/PRINCIPAL startup recovery language in `ENGINEERING_MCP_ROADMAP.md` was replaced by V1.5.x execution-ownership/manual-recovery semantics.

## J. Tests

Commands run:

```text
npm run typecheck
npm test
git diff --check
```

Results:

```text
8 test files passed
63 tests passed
```

Mixed-version regression tests added:

```text
3 tests
```

Coverage:

- Legacy claim after migration is rejected.
- Legacy report_result after migration is rejected.
- Legacy report_blocked after migration is rejected.
- Legacy RUNNING blocks migration.
- Legacy process remains alive through migration in the real-process regression tests.

All pre-existing current-version tests continue to pass.

## K. Invariants

- Maximum one `RUNNING` task: **preserved**.
- `RUNNING` always has `execution_instance_id`: **enforced by SQLite**.
- Non-`RUNNING` never has active `execution_instance_id`: **enforced by SQLite**.
- Legacy claim cannot create ownerless `RUNNING`: **enforced**.
- Legacy result/block cannot terminate a V2-owned `RUNNING`: **enforced**.
- Existing legacy `RUNNING` blocks migration: **enforced**.
- Startup has zero recovery side effects: **preserved**.
- Manual OWNER recovery remains unchanged: **preserved**.
- Repository binding remains enforced: **preserved**.
- Strict FIFO queue remains unchanged: **preserved**.

## L. Known limitations

- Old processes are not transparently compatible after migration.
- Old execution writes are intentionally fenced and may surface database-level errors.
- No heartbeat/lease.
- No automatic recovery.
- No parallel execution.
- No scheduler/worktree/merge behavior.

## M. Recommended next step

Perform an independent acceptance review by Sol Max.
