# Engineering MCP V1.5.4 — Current-Protocol Writer Fencing Report

## A. What changed

Implemented current-protocol writer fencing:

- Added a `writer_generation` task field.
- Added SQLite triggers requiring current-protocol writers to set/advance it.
- Existing migrated tasks are initialized to `writer_generation = 1`.
- Current task INSERTs must supply `writer_generation = 1`.
- Current task UPDATEs must advance `writer_generation = OLD.writer_generation + 1`.
- Legacy V1 writes that omit this field are rejected at the SQLite layer, even through already-open pre-migration connections.
- This is a general INSERT/UPDATE fence, not an API-specific `cancel_task` fix.

## B. Writer fencing design

SQLite distinguishes current writes from legacy writes using `writer_generation`:

- INSERT:
  - New current tasks must set `writer_generation = 1`.
  - `trg_tasks_writer_protocol_insert` rejects NULL or non-1 values.
  - Legacy V1 INSERT omits the column, leaving NULL, so it is rejected.

- UPDATE:
  - Current task updates must set `NEW.writer_generation = OLD.writer_generation + 1`.
  - `trg_tasks_writer_protocol_update` rejects NULL, non-incrementing values, or values that do not advance from the old row.
  - Legacy V1 UPDATE omits the column, leaving `NEW.writer_generation = OLD.writer_generation`, so it is rejected.

## C. General post-migration legacy-write rule

```text
Can a pre-migration legacy process successfully INSERT a task after migration?
NO

Can it successfully UPDATE a task after migration?
NO
```

## D. Exact latest blocker reproduction

```text
pre-opened legacy repo-B OWNER
current repo-A migration/binding
legacy cancel_task(existing repo-A READY task)
→ CURRENT_PROTOCOL_WRITER_REQUIRED
→ status remains READY
→ revision unchanged
→ no cancelled event
```

This is covered by `test/mixed-version.test.ts` test `rejects the exact legacy foreign cancel_task blocker after migration`.

## E. Same-repo legacy create

```text
pre-opened legacy repo-A process
current repo-A migration
legacy create_task
→ CURRENT_PROTOCOL_WRITER_REQUIRED
→ only the pre-migration task remains
```

Covered by `test/mixed-version.test.ts` test `rejects same-repository legacy create_task after migration`.

## F. Legacy write matrix

| Legacy operation | Reached SQL? | Result | DB state unchanged? |
|---|---|---|---|
| `create_task` | Yes | Rejected | Yes |
| `claim_task` | Yes | Rejected | Yes |
| `report_result` | Yes | Rejected | Yes |
| `report_blocked` | Yes | Rejected | Yes |
| `cancel_task` | Yes | Rejected | Yes |
| `close_task` | Yes | Rejected | Yes |
| `resume_task` | Yes (same-repo) | Rejected | Yes |
| generic `Store.updateTask` | Yes | Rejected | Yes |

All rejected legacy writes now receive `CURRENT_PROTOCOL_WRITER_REQUIRED` from SQLite when they reach a task write.

## G. Current write matrix

Current V1.5.4 operations continue to pass:

- `create_task`
- `claim_task`
- `claim_next_task`
- `report_result` COMPLETED/FAILED
- `report_blocked`
- `cancel_task`
- `close_task`
- `resume_task`
- `recover_task`

Covered by existing lifecycle/tools/smoke tests.

## H. Database invariants

```text
Can legacy INSERT commit?
NO

Can legacy UPDATE commit?
NO

Can RUNNING + NULL execution owner commit?
NO

Can non-RUNNING + non-null owner commit?
NO

Can foreign-repository task commit?
NO

Can arbitrary RUNNING → RUNNING update commit?
NO
```

## I. Migration

| Source DB | Behavior |
|---|---|
| V1 with legacy RUNNING | Migration refused. |
| V1 without RUNNING | Migrates and initializes writer fencing. |
| Valid V1.5.3/v4 DB | Upgrades to schema v5, preserves tasks/events, initializes `writer_generation = 1`. |
| V1.5.3 with RUNNING if tested | Current-owned RUNNING rows are initialized to `writer_generation = 1`; current protocol must advance on future writes. |
| Inconsistent repository DB | Fails closed. |

Migration is atomic: schema changes, writer column backfill, all trigger installation, and version bump occur in the same transaction.

## J. Already-open old connection proof

```text
Can that old connection write afterward?
NO
```

The exact same legacy process/connection opened before migration remains alive and attempts writes after migration in `test/mixed-version.test.ts`; all task INSERT/UPDATE attempts are rejected.

## K. Audit integrity

For rejected legacy writes:

```text
task residue: none
event residue: none
revision drift: none
writer-protocol field drift: none
metadata residue: none
```

## L. Safety object validation

New required fencing objects:

- `trg_tasks_writer_protocol_insert`
- `trg_tasks_writer_protocol_update`

Missing-object behavior:

- `Store.open` fails with `SCHEMA_FENCING_MISSING`.

A targeted test drops `trg_tasks_repository_invariant_update` similarly and verifies fail-closed open. Writer triggers are included in the same required-trigger validation.

## M. Tests

```text
npm run typecheck → PASS
npm test → PASS
git diff --check → PASS
```

Results:

```text
8 test files passed
76 tests passed
0 skipped
0 failed
```

## N. Documentation/version

Updated:

- `AI_PROJECT_STATE.md` → V1.5.4, schema v5.
- `src/server.ts` runtime banner → Engineering MCP V1.5.4.
- This report.

## O. Known limitations

- Legacy reads may remain possible according to existing permissions.
- Old clients must restart/upgrade before task mutation.
- No heartbeat.
- No lease.
- No automatic recovery.
- No scheduler.
- No parallel execution.
- No worktrees.
- No merge automation.

## P. Recommended next action

Targeted final acceptance review by Sol Max after quota reset.