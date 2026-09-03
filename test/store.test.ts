import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION, type TaskContract } from '../src/types.ts';
import { implPayload, openTempStore, removeDir } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function sampleTask(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'IMPLEMENTATION',
    status: 'READY',
    owner_role: 'OWNER',
    assignee_role: null,
    repo_root: 'C:\\repo',
    base_commit: 'aaa',
    branch: 'master',
    payload: implPayload,
    result: null,
    blocker: null,
    revision: 1,
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('Store', () => {
  it('initializes WAL, foreign keys, and schema user_version', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    opened.store.close();
    const raw = new DatabaseSync(opened.store.path);
    const version = Object.values(raw.prepare('PRAGMA user_version').get() as Record<string, number>)[0];
    const foreignKeys = Object.values(raw.prepare('PRAGMA foreign_keys').get() as Record<string, number>)[0];
    const journal = Object.values(raw.prepare('PRAGMA journal_mode').get() as Record<string, string>)[0];
    raw.close();
    expect(version).toBe(SCHEMA_VERSION);
    expect(foreignKeys).toBe(1);
    expect(String(journal).toLowerCase()).toBe('wal');
  });

  it('persists a task and its audit event', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = sampleTask();
    opened.store.transact(() => {
      opened.store.insertTask(task);
      opened.store.insertEvent({
        task_id: task.id,
        at: task.created_at,
        actor_role: 'OWNER',
        kind: 'created',
        from_status: null,
        to_status: 'READY',
        revision: 1,
      });
    });
    const loaded = opened.store.getTask(task.id);
    expect(loaded?.status).toBe('READY');
    expect(loaded?.payload).toEqual(implPayload);
    expect(opened.store.listEvents(task.id)).toHaveLength(1);
  });

  it('rolls back a failed transaction atomically', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = sampleTask();
    expect(() =>
      opened.store.transact(() => {
        opened.store.insertTask(task);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(opened.store.getTask(task.id)).toBeUndefined();
  });

  it('enforces a single RUNNING task', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    opened.store.insertTask(sampleTask({ status: 'RUNNING', assignee_role: 'JUNIOR' }));
    expect(() =>
      opened.store.insertTask(
        sampleTask({
          id: '22222222-2222-4222-8222-222222222222',
          type: 'DIAGNOSIS',
          status: 'RUNNING',
          assignee_role: 'PRINCIPAL',
        }),
      ),
    ).toThrow();
  });

  it('rejects an unknown schema user_version', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    opened.store.close();
    const raw = new DatabaseSync(join(opened.dir, 'ledger.sqlite'));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => Store.open(join(opened.dir, 'ledger.sqlite'))).toThrow(DomainError);
  });

  it('shares writes across two connections', () => {
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    const second = Store.open(opened.store.path);
    stores.push(second);
    const task = sampleTask();
    opened.store.insertTask(task);
    expect(second.getTask(task.id)?.id).toBe(task.id);
  });
});
