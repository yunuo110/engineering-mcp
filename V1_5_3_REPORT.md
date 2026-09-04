# Engineering MCP V1.5.3 — Repository & Legacy Writer Fencing Completion Report

## A. What changed

Implemented the V1.5.3 acceptance fixes:

- Added SQLite repository-binding triggers:
  - `trg_tasks_repository_invariant_insert`
  - `trg_tasks_repository_invariant_update`
- Added SQLite RUNNING-mutation fencing:
  - `trg_tasks_running_immutable_update`
- Enforced that every task `repo_root` equals `ledger_metadata.repository_root`.
- Enforced that arbitrary `RUNNING → RUNNING` task mutations are rejected.
- Closed the migration/binding window by performing migration and repository binding atomically inside the same transaction when a repo root is supplied.
- Added validation that a bound ledger contains no foreign-repository task roots.
- Repaired the Windows mixed-version harness by replacing GNU-specific tar extraction with portable `git show` file materialization.
- Repaired broad try/catch false-positive safety tests.
- Added real legacy-process regression coverage for:
  - legacy repo-B cross-repository task creation after repo-A binding;
  - legacy generic `Store.updateTask` RUNNING → RUNNING mutation.
- Updated runtime version strings and authoritative docs.

No V1.6 functionality was added.

## B. Repository database invariant

SQLite now guarantees:

```text
task.repo_root == ledger_metadata.repository_root
```

for both INSERT and UPDATE:

```text
trg_tasks_repository_invariant_insert
trg_tasks_repository_invariant_update
```

Both triggers fail with `REPOSITORY_BINDING_MISMATCH` if:

- repository metadata is absent; or
- `NEW.repo_root` does not equal the bound repository root.

Because these are SQLite triggers, they also apply to already-open legacy connections that were opened before migration.

## C. Cross-repository legacy reproduction

Actual mixed-version test result:

```text
Old repo-B connection opened before migration
current repo-A migration/binding
old repo-B create_task
→ rejected by SQLite repository trigger
→ no repo-B task inserted
→ no repo-B created event committed
→ existing repo-A history unchanged
```

## D. RUNNING mutation fencing

Actual mixed-version test result:

```text
current-owned RUNNING task
legacy generic Store.updateTask changes assignee/base_commit/revision
→ rejected by SQLite RUNNING immutability trigger
→ status unchanged
→ assignee unchanged
→ base_commit unchanged
→ revision unchanged
→ execution_instance_id unchanged
→ no audit residue
```

## E. Database invariants

```text
Can RUNNING + NULL owner commit?
NO

Can non-RUNNING + non-null owner commit?
NO

Can foreign-repository task INSERT commit?
NO

Can foreign-repository task UPDATE commit?
NO

Can arbitrary RUNNING → RUNNING task UPDATE commit?
NO
```

## F. Migration / binding atomicity

The migration and binding sequence is now atomic when a repository root is supplied:

```text
open DB
BEGIN IMMEDIATE
validate/schema migrate
ensure ledger_metadata.repository_root
validate execution-state invariant rows
validate task repo roots
install all fencing triggers
set user_version = 4
COMMIT
```

There is no committed window after migration where repository fencing is inactive.

## G. Upgrade compatibility

| Input DB | Behavior |
|---|---|
| V1 DB with RUNNING | Migration refused with `LEGACY_RUNNING_TASK_PREVENTS_MIGRATION`. |
| V1 DB without RUNNING | Migration proceeds and installs schema v4 fencing. |
| Valid V1.5.2/v3 DB | Upgraded to schema v4; repository metadata and historical tasks preserved. |
| Inconsistent/cross-repository DB | Open fails closed with `REPOSITORY_BINDING_MISMATCH`. |

## H. Audit integrity

For each rejected legacy write:

```text
task residue: none
event residue: none
revision drift: none
metadata residue: none
```

SQLite trigger aborts occur inside the old writer's transaction, so no partial task/event residue survives.

## I. Mixed-version tests

Each real legacy-process scenario keeps the legacy connection alive across migration:

| Scenario | Result |
|---|---|
| Legacy claim after migration | Rejected, task remains READY |
| Legacy report_result against V2-owned task | Rejected, task remains RUNNING |
| Legacy report_blocked against V2-owned task | Rejected, task remains RUNNING |
| Legacy repo-B create_task after repo-A binding | Rejected by repository trigger |
| Legacy generic RUNNING → RUNNING update | Rejected by RUNNING immutability trigger |
| Legacy RUNNING blocks migration | Migration fails closed |

All scenarios use genuine old source from commit `6b38cf4`.

## J. Windows test harness

The old GNU-specific path:

```text
tar --force-local
```

was removed.

The mixed-version harness now materializes the legacy V1 source with:

```text
git show 6b38cf4:src/<file>
```

and writes each source file directly with Node `fs`. This is portable across the supported Windows environment and still executes genuine old source code.

## K. Test results

Commands run:

```text
npm run typecheck
npm test
git diff --check
```

Results:

```text
8 test files passed
70 tests passed
```

All current-version and mixed-version tests pass.

## L. Documentation

Updated documents:

- `AI_PROJECT_STATE.md`
- `ENGINEERING_MCP_ROADMAP.md`
- `V1_5_3_REPORT.md`

Runtime banner updated:

```text
Engineering MCP V1.5.3 coordination ledger
```

No V1.5.1 runtime banner remains.

## M. Invariants

- Maximum one `RUNNING`: **preserved**.
- `RUNNING` requires execution owner: **preserved/enforced**.
- Non-`RUNNING` has no active execution owner: **preserved/enforced**.
- Same-role different instance cannot mutate active execution: **preserved/enforced**.
- Legacy current-owned terminal mutations are fenced: **preserved/enforced**.
- Legacy `RUNNING → RUNNING` mutations are fenced: **enforced**.
- One ledger = one canonical repository: **enforced at SQLite layer**.
- Legacy cross-repository writes are fenced: **enforced**.
- Startup has zero recovery side effects: **preserved**.
- Manual OWNER recovery preserved: **preserved**.
- Strict FIFO preserved: **preserved**.

## N. Known limitations

- No heartbeat.
- No lease.
- No automatic recovery.
- No scheduler.
- No parallel execution.
- No worktrees.
- No merge automation.
- Old clients are intentionally write-fenced after upgrade and may receive database-level errors.

## O. Recommended next action

Independent final acceptance review by Sol Max.
