# Engineering MCP V1.5.1 — Safety / Execution Ownership Patch Report

## A. What changed

Implemented the V1.5.1 safety patch:

- Removed automatic startup recovery entirely. Starting a server no longer mutates persisted `RUNNING` tasks.
- Added a server-generated `execution_instance_id` for every MCP process/instance.
- Persisted execution ownership on `RUNNING` tasks.
- Both `claim_task` and `claim_next_task` now record the claiming server instance as execution owner.
- `report_result` and `report_blocked` now require:
  - correct assigned role;
  - matching `execution_instance_id`.
- A same-role but different-instance worker cannot mutate another process’s `RUNNING` task.
- Added OWNER-only `recover_task(task_id, expected_revision)`:
  - explicit;
  - task-specific;
  - revision-protected;
  - repository-bound;
  - transitions `RUNNING → BLOCKED`;
  - clears execution ownership;
  - writes `CONTEXT_STALE` blocker and structured recovery metadata.
- Added persistent ledger repository binding. A ledger is bound to one canonical repository and fails closed when opened from another repository.
- Migration from schema v1 to v2 adds `tasks.execution_instance_id` and `ledger_metadata` while preserving task/event data.
- Updated documentation to describe fail-closed manual recovery semantics.

## B. Files changed

| File | Purpose | Key change |
|---|---|---|
| `src/errors.ts` | Domain error catalog | Added `NO_PENDING_TASK`, `EXECUTION_OWNER_MISMATCH`, `REPOSITORY_BINDING_MISMATCH`, `INVALID_RECOVERY_STATE`. |
| `src/types.ts` | Schemas/types | Bumped `SCHEMA_VERSION` to `2`; added `execution_instance_id` to task contracts; added `recover_task` input; added `EXPLICIT_OWNER_RECOVERY` recovery reason and `prior_execution_instance_id`. |
| `src/store.ts` | SQLite layer | Added schema v2 columns/table; migration from v1; `ledger_metadata` repository binding; `bindRepository()`; `execution_instance_id` persistence. |
| `src/lifecycle.ts` | Domain lifecycle | Removed auto-recovery `recoverStaleRunning`; added execution-owner setting/clearing; added explicit `recoverTask`; enforced owner for worker mutations. |
| `src/server.ts` | MCP server startup | Removed startup recovery; startup is now execution-state side-effect free. |
| `src/index.ts` | Process entrypoint | Generates a trusted random `executionInstanceId` per process; opens DB with repository binding. |
| `src/role.ts` | Tool permissions | Added `recover_task` to OWNER tools. |
| `src/tools.ts` | MCP tools | Passes trusted `executionInstanceId` through claims/reports; registers `recover_task`; binds ledger repo at tool registration time. |
| `src/git.ts` | Git helpers | Exported repository-root comparison helper for recovery validation. |
| `test/helpers.ts` | Test helpers | Generates in-process server instance IDs and returns them from `connectInProcess`. |
| `test/lifecycle.test.ts` | Unit/integration tests | Replaced auto-recovery tests with explicit recovery tests; added ownership enforcement and owner-clearing coverage. |
| `test/store.test.ts` | Store tests | Added V1 migration test and ledger repository binding tests. |
| `test/tools.test.ts` | MCP tool tests | Added no-auto-recovery startup tests and `recover_task` tool coverage. |
| `test/safety-multiprocess.test.ts` | New real stdio multi-process regression suite | Tests live second-process startup, same-role mutation isolation, explicit recovery, stale revision recovery, one-RUNNING invariant, and cross-repo ledger misuse. |
| `AI_PROJECT_STATE.md` | Project docs | Updated to V1.5.1 semantics. |

## C. Startup behavior

Can starting a second MCP process modify/recover an existing RUNNING task?

**NO.**

Server startup now only opens/validates the repository and database, binds the ledger if needed, and registers tools. It does not inspect or mutate any persisted `RUNNING` task. A second same-role process can read the task but leaves it `RUNNING` with its original revision and execution owner.

## D. Execution ownership

A `RUNNING` task is now uniquely owned by:

- **Role**: `assignee_role` still controls which role is authorized/assigned.
- **Server/execution instance**: `execution_instance_id` controls which specific trusted MCP process currently owns the active execution.
- **Persistence**: `execution_instance_id` is stored in the `tasks` table.
- **Lifecycle**:
  - `READY`: `execution_instance_id = null`;
  - `claim_task` / `claim_next_task`: set to the claiming server instance;
  - terminal/blocked/recovered/resumed/cancelled/closed: cleared to `null`.

## E. Database changes

- Schema version: `1 → 2`.
- New columns/table:
  - `tasks.execution_instance_id TEXT`
  - `ledger_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
- Migration:
  - Existing v1 DBs are migrated deterministically.
  - Existing task/event rows are preserved.
  - Existing RUNNING rows receive `execution_instance_id = null` and must be recovered explicitly before further execution mutation.
- Ledger repository binding:
  - Stored in `ledger_metadata.repository_root`.
  - If absent and all existing tasks agree on one repository, the binding is initialized from that evidence.
  - If absent and tasks are inconsistent, binding fails closed.
  - If present and mismatched, `Store.open`/`bindRepository` fails closed.

## F. Recovery behavior

```text
RUNNING
  ↓ explicit OWNER recover_task(task_id, expected_revision)
BLOCKED
```

- OWNER-only.
- Requires current `revision == expected_revision`.
- Requires canonical repository root match with the task’s `repo_root`.
- Clears `execution_instance_id`.
- Writes `CONTEXT_STALE` blocker with recovery metadata:
  - reason: `EXPLICIT_OWNER_RECOVERY`
  - previous status: `RUNNING`
  - detected_by_role: `OWNER`
  - retry_safe: `false`
  - prior_execution_instance_id
- Also writes a `blocked` audit event containing recovery metadata.

## G. Repository safety

`repo B + repo A DB` is now prevented:

- Actual stdio startup calls `Store.open(dbPath, { repoRoot: repoPath })`.
- The DB stores the canonical repository root in `ledger_metadata`.
- If the metadata already names repo A and startup repo is repo B, `Store.open` throws `REPOSITORY_BINDING_MISMATCH` before the server becomes usable.
- In-process servers also call `store.bindRepository(config.repoPath)` during tool registration as defense in depth.
- Explicit `recover_task` additionally checks the task-level `repo_root` against the current server repository.

## H. Ownership security test

The mandatory same-role multi-process test passes:

```text
Junior A claims X
Junior B (same role, different process/instance)
  report_blocked(X)  → EXECUTION_OWNER_MISMATCH
  report_result(X)   → EXECUTION_OWNER_MISMATCH
X remains RUNNING with execution owner A
Junior A can still complete X
```

This is covered by both lifecycle unit tests and real stdio multi-process tests.

## I. Multi-process regression results

New real stdio suite `test/safety-multiprocess.test.ts` ran all cases successfully:

| Case | Result |
|---|---|
| Second same-role process starts while A owns RUNNING | PASS — task remains RUNNING, owner unchanged |
| Same-role B attempts report_result/report_blocked | PASS — `EXECUTION_OWNER_MISMATCH`, no mutation |
| A completes its own task | PASS |
| Explicit OWNER recovery | PASS — `RUNNING → BLOCKED`, owner cleared, audit written |
| Late old-execution report after recovery | PASS — `REVISION_MISMATCH` |
| Stale-revision OWNER recovery | PASS — `REVISION_MISMATCH`, zero writes |
| Two worker processes near-concurrent claims | PASS — second gets `TASK_ALREADY_RUNNING`, only one RUNNING |
| Repo B opens repo A-bound DB | PASS — startup fails closed |

## J. Tests

Commands run:

```text
npm run typecheck
npm test
git diff --check
```

Results:

```text
7 test files passed
55 tests passed
```

All existing intended tests continue to pass. Tests that previously asserted automatic startup recovery were intentionally converted to assert the new no-auto-recovery behavior.

## K. Invariants

- Maximum one `RUNNING` task: **preserved**.
- Startup is execution-state side-effect free: **preserved/enforced**.
- Same-role different instance cannot mutate `RUNNING`: **enforced**.
- Explicit recovery is revision-protected: **enforced**.
- Recovery is repository-bound: **enforced**.
- Cross-repo ledger misuse fails closed: **enforced**.
- Task history is preserved: **preserved**.
- Retry remains explicit through OWNER `resume_task`: **preserved**.
- Queue FIFO semantics unchanged: **preserved**.

## L. Known limitations

- No automatic dead-worker detection.
- No heartbeat or lease mechanism.
- A crashed worker leaves its task `RUNNING` until an OWNER explicitly calls `recover_task`.
- No parallel execution.
- No worktree/scheduler/merge behavior.
- Existing migrated V1 RUNNING rows have no execution owner and must be explicitly recovered before worker mutation can resume.

## M. Recommended next step

Perform an independent acceptance review of the V1.5.1 patch; do not begin the next feature.
