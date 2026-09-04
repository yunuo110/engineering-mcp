import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION, type TaskContract } from '../src/types.ts';
import { implPayload, openTempStore, removeDir, tempDir } from './helpers.ts';

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
    execution_instance_id: null,
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
    const opened = openTempStore('C:\\repo');
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
    const opened = openTempStore('C:\\repo');
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
    const opened = openTempStore('C:\\repo');
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
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    opened.store.insertTask(sampleTask({ status: 'RUNNING', assignee_role: 'JUNIOR', execution_instance_id: 'instance-a' }));
    expect(() =>
      opened.store.insertTask(
        sampleTask({
          id: '22222222-2222-4222-8222-222222222222',
          type: 'DIAGNOSIS',
          status: 'RUNNING',
          assignee_role: 'PRINCIPAL',
          execution_instance_id: 'instance-b',
        }),
      ),
    ).toThrow();
  });

  it('rejects an unknown schema user_version', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    opened.store.close();
    const raw = new DatabaseSync(join(opened.dir, 'ledger.sqlite'));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => Store.open(join(opened.dir, 'ledger.sqlite'))).toThrow(DomainError);
  });

  it('shares writes across two connections', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const second = Store.open(opened.store.path);
    stores.push(second);
    const task = sampleTask();
    opened.store.insertTask(task);
    expect(second.getTask(task.id)?.id).toBe(task.id);
  });

  it('migrates a V1 database without losing tasks or events', () => {
    const opened = openTempStore('C:\\repo');
    dirs.push(opened.dir);
    opened.store.close();
    const path = join(opened.dir, 'v1-ledger.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        assignee_role TEXT,
        repo_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        blocker_json TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        at TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
    `);
    raw.prepare(`
      INSERT INTO tasks (
        id, type, status, owner_role, assignee_role, repo_root, base_commit, branch,
        payload_json, result_json, blocker_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'migrated-task',
      'IMPLEMENTATION',
      'READY',
      'OWNER',
      null,
      'repo-a',
      'aaa',
      'main',
      JSON.stringify(implPayload),
      null,
      null,
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    raw.exec(`PRAGMA user_version = 1`);
    raw.close();

    const migrated = Store.open(path, { repoRoot: 'repo-a' });
    stores.push(migrated);
    const task = migrated.getTask('migrated-task');
    expect(task?.execution_instance_id).toBeNull();
    expect(task?.repo_root).toBe('repo-a');
    expect(migrated.repositoryRoot).toBe('repo-a');
    const versionRaw = new DatabaseSync(path);
    const version = Object.values(
      (versionRaw.prepare('PRAGMA user_version').get() as Record<string, number>),
    )[0];
    versionRaw.close();
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('binds a ledger to one repository and rejects a different repository', () => {
    const opened = openTempStore('repo-a');
    dirs.push(opened.dir);
    opened.store.close();
    const path = join(opened.dir, 'ledger.sqlite');

    const bound = Store.open(path, { repoRoot: 'repo-a' });
    bound.close();
    let mismatchError: unknown;
    try {
      Store.open(path, { repoRoot: 'repo-b' });
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toBeInstanceOf(DomainError);
    expect((mismatchError as DomainError).code).toBe('REPOSITORY_BINDING_MISMATCH');
  });

  it('infers repository binding only when existing tasks agree', () => {
    const dir = tempDir('eng-mcp-store-infer-');
    dirs.push(dir);
    const path = join(dir, 'ledger.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        assignee_role TEXT,
        repo_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        blocker_json TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        at TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
    `);
    raw.prepare(`
      INSERT INTO tasks (
        id, type, status, owner_role, assignee_role, repo_root, base_commit, branch,
        payload_json, result_json, blocker_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'repo-a-task',
      'IMPLEMENTATION',
      'READY',
      'OWNER',
      null,
      'repo-a',
      'aaa',
      'main',
      JSON.stringify(implPayload),
      null,
      null,
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    raw.exec(`PRAGMA user_version = 1`);
    raw.close();

    const bound = Store.open(path, { repoRoot: 'repo-a' });
    expect(bound.repositoryRoot).toBe('repo-a');
    bound.close();
    expect(() => Store.open(path, { repoRoot: 'repo-b' })).toThrow(DomainError);
  });

  it('rejects ownerless RUNNING rows at the database layer', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    expect(() =>
      opened.store.insertTask(sampleTask({ status: 'RUNNING', assignee_role: 'JUNIOR' })),
    ).toThrow(/EXECUTION_STATE_INVARIANT_VIOLATION/);
  });

  it('rejects non-RUNNING rows that retain an execution owner', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    expect(() =>
      opened.store.insertTask(
        sampleTask({
          id: 'completed-with-owner',
          status: 'COMPLETED',
          assignee_role: 'JUNIOR',
          execution_instance_id: 'stale-owner',
        }),
      ),
    ).toThrow(/EXECUTION_STATE_INVARIANT_VIOLATION/);
  });

  it('rejects a legacy-style update from RUNNING/owner to COMPLETED/owner', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = sampleTask({
      status: 'RUNNING',
      assignee_role: 'JUNIOR',
      execution_instance_id: 'current-owner',
    });
    opened.store.insertTask(task);
    expect(() =>
      opened.store.updateTask({
        ...task,
        status: 'COMPLETED',
        execution_instance_id: 'current-owner',
        revision: 2,
      }),
    ).toThrow(/EXECUTION_STATE_INVARIANT_VIOLATION/);
    const after = opened.store.getTask(task.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.execution_instance_id).toBe('current-owner');
  });

  it('accepts valid execution ownership transitions at the database layer', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const ready = sampleTask({ id: 'valid-task' });
    opened.store.insertTask(ready);
    const running = {
      ...ready,
      status: 'RUNNING' as const,
      assignee_role: 'JUNIOR' as const,
      execution_instance_id: 'current-owner',
      revision: 2,
    };
    opened.store.updateTask(running);
    expect(opened.store.getTask(ready.id)?.status).toBe('RUNNING');
    expect(opened.store.getTask(ready.id)?.execution_instance_id).toBe('current-owner');

    const completed = {
      ...running,
      status: 'COMPLETED' as const,
      execution_instance_id: null,
      result: null,
      revision: 3,
    };
    opened.store.updateTask(completed);
    expect(opened.store.getTask(ready.id)?.status).toBe('COMPLETED');
    expect(opened.store.getTask(ready.id)?.execution_instance_id).toBeNull();
  });

  it('refuses migration when a legacy RUNNING task exists', () => {
    const opened = openTempStore('C:\\repo');
    dirs.push(opened.dir);
    opened.store.close();
    const path = join(opened.dir, 'legacy-running.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        assignee_role TEXT,
        repo_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        blocker_json TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        at TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
    `);
    raw.prepare(`
      INSERT INTO tasks (
        id, type, status, owner_role, assignee_role, repo_root, base_commit, branch,
        payload_json, result_json, blocker_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-running',
      'IMPLEMENTATION',
      'RUNNING',
      'OWNER',
      'JUNIOR',
      'repo-a',
      'aaa',
      'main',
      JSON.stringify(implPayload),
      null,
      null,
      2,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    raw.exec(`PRAGMA user_version = 1`);
    raw.close();

    let migrationError: unknown;
    try {
      Store.open(path, { repoRoot: 'repo-a' });
    } catch (error) {
      migrationError = error;
    }
    expect(migrationError).toBeInstanceOf(DomainError);
    expect((migrationError as DomainError).code).toBe('LEGACY_RUNNING_TASK_PREVENTS_MIGRATION');
  });

  it('rejects a foreign-repository task INSERT at the database layer', () => {
    const opened = openTempStore('repo-a');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const foreign = sampleTask({ id: 'foreign-insert', repo_root: 'repo-b' });
    expect(() => opened.store.insertTask(foreign)).toThrow(/REPOSITORY_BINDING_MISMATCH/);
    expect(opened.store.getTask(foreign.id)).toBeUndefined();
  });

  it('rejects a foreign-repository task UPDATE at the database layer', () => {
    const opened = openTempStore('repo-a');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = sampleTask({ id: 'repo-a-task', repo_root: 'repo-a' });
    opened.store.insertTask(task);
    expect(() =>
      opened.store.updateTask({
        ...task,
        repo_root: 'repo-b',
        revision: 2,
      }),
    ).toThrow(/REPOSITORY_BINDING_MISMATCH/);
    const after = opened.store.getTask(task.id);
    expect(after?.repo_root).toBe('repo-a');
    expect(after?.revision).toBe(task.revision);
  });

  it('rejects RUNNING to RUNNING task mutation at the database layer', () => {
    const opened = openTempStore('repo-a');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = sampleTask({
      id: 'running-task',
      repo_root: 'repo-a',
      status: 'RUNNING',
      assignee_role: 'JUNIOR',
      execution_instance_id: 'owner-a',
    });
    opened.store.insertTask(task);
    expect(() =>
      opened.store.updateTask({
        ...task,
        assignee_role: 'PRINCIPAL',
        base_commit: 'changed',
        revision: 3,
      }),
    ).toThrow(/EXECUTION_STATE_INVARIANT_VIOLATION/);
    const after = opened.store.getTask(task.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.assignee_role).toBe('JUNIOR');
    expect(after?.base_commit).toBe('aaa');
    expect(after?.execution_instance_id).toBe('owner-a');
    expect(after?.revision).toBe(task.revision);
  });

  it('upgrades a valid v3 database while preserving repository binding', () => {
    const dir = tempDir('eng-mcp-store-v3-upgrade-');
    dirs.push(dir);
    const path = join(dir, 'ledger.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        assignee_role TEXT,
        execution_instance_id TEXT,
        repo_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        blocker_json TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        at TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
      CREATE TABLE ledger_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    raw.prepare(`INSERT INTO ledger_metadata (key, value) VALUES ('repository_root', 'repo-a')`).run();
    raw.prepare(`
      INSERT INTO tasks (
        id, type, status, owner_role, assignee_role, execution_instance_id,
        repo_root, base_commit, branch, payload_json, result_json, blocker_json,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'v3-task',
      'IMPLEMENTATION',
      'READY',
      'OWNER',
      null,
      null,
      'repo-a',
      'aaa',
      'main',
      JSON.stringify(implPayload),
      null,
      null,
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    raw.exec(`PRAGMA user_version = 3`);
    raw.close();

    const upgraded = Store.open(path, { repoRoot: 'repo-a' });
    stores.push(upgraded);
    expect(upgraded.repositoryRoot).toBe('repo-a');
    expect(upgraded.getTask('v3-task')?.repo_root).toBe('repo-a');
    const versionRaw = new DatabaseSync(path);
    const version = Object.values(
      (versionRaw.prepare('PRAGMA user_version').get() as Record<string, number>),
    )[0];
    versionRaw.close();
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('refuses to open a v3 database whose existing tasks cross repository roots', () => {
    const dir = tempDir('eng-mcp-store-v3-inconsistent-');
    dirs.push(dir);
    const path = join(dir, 'ledger.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        assignee_role TEXT,
        execution_instance_id TEXT,
        repo_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        blocker_json TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        at TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
      CREATE TABLE ledger_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    raw.prepare(`INSERT INTO ledger_metadata (key, value) VALUES ('repository_root', 'repo-a')`).run();
    raw.prepare(`
      INSERT INTO tasks (
        id, type, status, owner_role, assignee_role, execution_instance_id,
        repo_root, base_commit, branch, payload_json, result_json, blocker_json,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'foreign-v3-task',
      'IMPLEMENTATION',
      'READY',
      'OWNER',
      null,
      null,
      'repo-b',
      'aaa',
      'main',
      JSON.stringify(implPayload),
      null,
      null,
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    raw.exec(`PRAGMA user_version = 3`);
    raw.close();

    let openError: unknown;
    try {
      Store.open(path, { repoRoot: 'repo-a' });
    } catch (error) {
      openError = error;
    }
    expect(openError).toBeInstanceOf(DomainError);
    expect((openError as DomainError).code).toBe('REPOSITORY_BINDING_MISMATCH');
  });

  it('fails closed when a required fencing trigger is missing', () => {
    const opened = openTempStore('repo-a');
    dirs.push(opened.dir);
    opened.store.close();
    const path = opened.store.path;
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER IF EXISTS trg_tasks_repository_invariant_update');
    raw.close();

    let openError: unknown;
    try {
      Store.open(path, { repoRoot: 'repo-a' });
    } catch (error) {
      openError = error;
    }
    expect(openError).toBeInstanceOf(DomainError);
    expect((openError as DomainError).code).toBe('SCHEMA_FENCING_MISSING');
  });
});
