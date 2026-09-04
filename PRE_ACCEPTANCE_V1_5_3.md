# PRE-ACCEPTANCE V1.5.3

## A. Overall Pre-Acceptance Result

```text
READY FOR SOL FINAL REVIEW
```

The three previous Sol acceptance blockers are closed in commit `081edd7`; full test suite passes; no new BLOCKER/HIGH regression was found during this pre-acceptance check.

## B. Commit Reviewed

```text
081edd7
```

The verification also added small test-only changes for false-positive assertion hardening and a missing-required-trigger probe; production code was not changed during this verification pass.

## C. Previous Finding Closure Matrix

| Previous finding | Status | Evidence |
|---|---|---|
| Legacy cross-repo injection through already-open V1 connection | CLOSED | `test/mixed-version.test.ts` test `fences a pre-opened legacy repo-B connection from creating tasks after repo-A binding` passes. Old repo-B process remains open across migration; `create_task` returns `REPOSITORY_BINDING_MISMATCH`; only repo-A task remains. |
| Legacy valid-shaped RUNNING → RUNNING generic update | CLOSED | `test/mixed-version.test.ts` test `fences a legacy generic RUNNING to RUNNING update through an already-open store` passes. Legacy `Store.updateTask` attempt changing `assignee_role`, `base_commit`, `revision` is rejected with `EXECUTION_STATE_INVARIANT_VIOLATION`; final task fields/owner/revision unchanged. |
| Windows mixed-version harness / false-positive repository test | CLOSED | Mixed-version fixture no longer uses `tar --force-local`; it materializes legacy source via `git show` + Node `fs`. The repository rejection tests use capture patterns that fail when a forbidden operation unexpectedly succeeds. Full unmodified `npm test` passes. |

## D. Repository Fence Evidence

Real old-process reproduction:

```text
Old repo-B process opened before migration can create in repo-A ledger?
NO
```

Evidence:

- `legacyOwnerA` and `legacyOwnerB` are both started against the same DB before migration.
- After repo-A migration/binding, `legacyOwnerB.create_task` is rejected.
- DB inspection shows one active task with `repo_root = repoA`; no foreign task or created event is committed.
- This is enforced by SQLite triggers:
  - `trg_tasks_repository_invariant_insert`
  - `trg_tasks_repository_invariant_update`

## E. RUNNING Mutation Fence Evidence

```text
Legacy generic updateTask can mutate current-owned RUNNING row?
NO
```

Evidence:

- Current code claims the task as `RUNNING` with `execution_instance_id = 'v153-owner'`.
- A legacy helper process opened before migration attempts:
  - `status = RUNNING`
  - `assignee_role = PRINCIPAL`
  - `base_commit = changed-by-legacy`
  - `revision = running.revision + 1`
- SQLite rejects with `EXECUTION_STATE_INVARIANT_VIOLATION`.
- Final persisted values:
  - `status = RUNNING`
  - `assignee_role = JUNIOR`
  - `base_commit = original`
  - `revision = original running revision`
  - `execution_instance_id = v153-owner`

## F. Migration / Binding Atomicity

```text
Committed unfenced upgrade window exists?
NO
```

Transaction sequence in `migrateAndValidate` when a repo root is supplied:

```text
BEGIN IMMEDIATE
schema/migration steps
ensure ledger_metadata.repository_root
validate execution-state invariant rows
validate task repo roots
install all fencing triggers
set user_version = 4
COMMIT
```

Repository binding and repository-trigger installation happen before `user_version` is set and before commit. There is no committed current-schema state without repository fencing.

## G. Audit Integrity

For the rejected legacy cross-repo create:

```text
task residue: none
event residue: none
revision drift: none
metadata residue: none
```

For the rejected legacy RUNNING → RUNNING update:

```text
task residue: none (all fields unchanged)
event residue: none
revision drift: none
metadata residue: none
```

These are covered by direct DB inspection in `test/mixed-version.test.ts` and `test/store.test.ts`.

## H. Windows Mixed-Version Test Status

```text
Actual OS: Windows (Git Bash / Node on Windows)
Harness method: git show per source file + Node fs writes
Genuine old process used: YES
Assertions reached: YES
```

The previous GNU-specific `tar --force-local` dependency has been removed.

## I. Full Verification

```text
npm run typecheck → PASS
npm test → PASS
git diff --check → PASS
```

Exact results after the small verification test additions:

```text
8 test files passed
71 tests passed
0 failed
```

## J. Targeted Regression Results

| Target | Result |
|---|---|
| V1 legacy RUNNING migration refusal | PASS |
| V1 safe migration | PASS |
| V1.5.2 → V1.5.3 upgrade | PASS |
| Cross-repo inconsistent DB rejection | PASS |
| Current valid claim/result/block/recovery | PASS |
| One-RUNNING spot-check | PASS |
| Missing required trigger rejection | PASS (added probe: drop `trg_tasks_repository_invariant_update`, open fails with `SCHEMA_FENCING_MISSING`) |

## K. New Findings

```text
No new BLOCKER/HIGH findings found.
```

During verification, only test-only hardening was added:

- Replaced remaining broad `try { ... expect.fail() } catch` false-positive patterns in `test/git.test.ts`.
- Added a store probe proving a missing required fencing trigger causes fail-closed open.

## L. Sol Final Review Targets

1. Inspect repository INSERT/UPDATE trigger logic in `src/store.ts`.
2. Reproduce one real old repo-B `create_task` after repo-A migration using `test/mixed-version.test.ts`.
3. Reproduce legacy generic `RUNNING → RUNNING` update rejection using `test/mixed-version.test.ts`.
4. Verify migration/binding transaction boundary in `migrateAndValidate` / `Store.open`.
5. Run `npm test` and confirm 71 tests pass.

## M. Recommendation

```text
Recommend targeted Sol final acceptance review of commit 081edd7.
```
