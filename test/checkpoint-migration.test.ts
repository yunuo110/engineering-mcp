import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelTask, checkpointTask, claimTask, createTask, reportBlocked, reportResult } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/types.ts';
import { implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('schema V8 checkpoint migration', () => {
  it('atomically adds checkpoint storage and preserves V7 task events', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const path = opened.store.path;
    opened.store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_update');
    legacy.exec('DROP TABLE task_checkpoints');
    legacy.exec('PRAGMA user_version = 7');
    legacy.close();

    const migrated = Store.open(path, { repoRoot: repo });
    stores.push(migrated);
    expect(migrated.getTask(task.id)).toEqual(task);
    expect(migrated.listEvents(task.id).map((event) => event.kind)).toEqual(['created']);
    expect(migrated.listCheckpoints(task.id)).toEqual([]);

    const raw = new DatabaseSync(path);
    const version = Object.values(raw.prepare('PRAGMA user_version').get() as Record<string, number>)[0];
    const checkpointTable = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_checkpoints'`)
      .get() as { name: string } | undefined;
    raw.close();
    expect(version).toBe(SCHEMA_VERSION);
    expect(checkpointTable?.name).toBe('task_checkpoints');
  });

  it('fences a pre-open V7 +2 writer after migration while V8 remains writable', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const checkpointPayload = { ...implPayload, allowed_scope: ['output.txt'], forbidden_scope: [], context_files: [] };
    const blockedCreated = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload: checkpointPayload });
    const blockedRunning = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'v7-blocked', blockedCreated.id, blockedCreated.revision);
    const blocked = reportBlocked(opened.store, 'JUNIOR', 'v7-blocked', {
      task_id: blockedRunning.id,
      revision: blockedRunning.revision,
      blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'resume', evidence_refs: [] },
    });
    const completedCreated = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const completedRunning = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'v7-completed', completedCreated.id, completedCreated.revision);
    const completed = reportResult(opened.store, 'JUNIOR', 'v7-completed', {
      task_id: completedRunning.id,
      revision: completedRunning.revision,
      outcome: 'completed',
      result: implResult,
    });
    const path = opened.store.path;
    opened.store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_update');
    legacy.exec('DROP TABLE task_checkpoints');
    legacy.exec('PRAGMA user_version = 7');
    const legacyTransition = legacy.prepare(
      `UPDATE tasks SET status = ?, writer_generation = writer_generation + 2,
       revision = revision + 1, updated_at = ? WHERE id = ?`,
    );
    const migrated = Store.open(path, { repoRoot: repo });
    stores.push(migrated);
    writeFileSync(join(repo, 'output.txt'), 'pending\n');
    expect(() => checkpointTask(migrated, snapshot(repo), {
      task_id: blocked.id,
      revision: blocked.revision,
      purpose: 'RESUME',
    }, { onStage(stage) { if (stage === 'after_intent') throw new Error('pending checkpoint'); } })).toThrow('pending checkpoint');

    const at = new Date().toISOString();
    for (const [id, status] of [
      [task.id, 'CANCELLED'],
      [blocked.id, 'READY'],
      [completed.id, 'CLOSED'],
    ] as const) {
      expect(() => legacyTransition.run(status, at, id)).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED|CHECKPOINT_FINALIZATION_REQUIRED/);
    }
    legacy.close();

    expect(migrated.getTask(task.id)?.status).toBe('READY');
    expect(migrated.getTask(blocked.id)?.status).toBe('BLOCKED');
    expect(migrated.getTask(completed.id)?.status).toBe('COMPLETED');
    expect(() => cancelTask(migrated, task.id, task.revision)).toThrow(/checkpoint|Checkpoint/i);
    checkpointTask(migrated, snapshot(repo), {
      task_id: blocked.id,
      revision: blocked.revision,
      purpose: 'RESUME',
    });
    expect(cancelTask(migrated, task.id, task.revision).status).toBe('CANCELLED');
  });

  it('fences pre-open V7 result and blocker transitions after migration', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    dirs.push(opened.dir);
    const created = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const running = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'v7-running', created.id, created.revision);
    const path = opened.store.path;
    opened.store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_update');
    legacy.exec('DROP TABLE task_checkpoints');
    legacy.exec('PRAGMA user_version = 7');
    const legacyReport = legacy.prepare(
      `UPDATE tasks SET status = ?, execution_instance_id = NULL,
       writer_generation = writer_generation + 2, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    );

    const migrated = Store.open(path, { repoRoot: repo });
    stores.push(migrated);
    const at = new Date().toISOString();
    expect(() => legacyReport.run('BLOCKED', at, running.id)).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED/);
    expect(() => legacyReport.run('COMPLETED', at, running.id)).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED/);
    legacy.close();

    expect(migrated.getTask(running.id)?.status).toBe('RUNNING');
    expect(reportBlocked(migrated, 'JUNIOR', 'v7-running', {
      task_id: running.id,
      revision: running.revision,
      blocker: { reason: 'OTHER', summary: 'current writer', need_from_owner: 'none', evidence_refs: [] },
    }).status).toBe('BLOCKED');
  });

  it('rolls back every V8 schema change when legacy event validation fails', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const path = opened.store.path;
    opened.store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_checkpoint_fence_update');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_insert');
    legacy.exec('DROP TRIGGER IF EXISTS trg_tasks_review_source_update');
    legacy.exec('DROP TABLE task_checkpoints');
    legacy.exec('PRAGMA ignore_check_constraints = ON');
    legacy.prepare(`UPDATE task_events SET kind = 'unknown-v7-event' WHERE task_id = ?`).run(task.id);
    legacy.exec('PRAGMA ignore_check_constraints = OFF');
    legacy.exec('PRAGMA user_version = 7');
    legacy.close();

    expect(() => Store.open(path, { repoRoot: repo })).toThrow();
    const after = new DatabaseSync(path);
    const version = Object.values(after.prepare('PRAGMA user_version').get() as Record<string, number>)[0];
    const tables = (
      after
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const kind = (after.prepare(`SELECT kind FROM task_events WHERE task_id = ?`).get(task.id) as { kind: string }).kind;
    after.close();
    expect(version).toBe(7);
    expect(tables).toContain('task_events');
    expect(tables).not.toContain('task_events_pre_v8');
    expect(tables).not.toContain('task_checkpoints');
    expect(kind).toBe('unknown-v7-event');
  });
});
