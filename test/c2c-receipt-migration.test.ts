import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointTask,
  claimTask,
  createTask,
  reportBlocked,
} from '../src/lifecycle.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { Store } from '../src/store.ts';
import {
  SCHEMA_VERSION,
  WRITER_PROTOCOL_GENERATION,
  type DispatchRun,
  type TaskContract,
} from '../src/types.ts';
import type {
  C2CMessage,
  TrustedActorContext,
} from '../src/c2c/schema.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-receipt-worker.ts', import.meta.url),
);
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function closeTracked(store: Store): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

function ownerMessage(task: TaskContract, id: string): C2CMessage {
  return {
    protocol_version: 'engineering-c2c/1',
    message_id: id,
    task_id: task.id,
    sender_role: 'OWNER',
    state: 'PLAN',
    expected_revision: task.revision,
    goal: 'migration receipt',
  };
}

function ownerContext(repo: string): TrustedActorContext {
  return {
    actor_role: 'OWNER',
    repo_root: repo,
  };
}

function downgradeCurrentLedgerToV8(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TABLE IF EXISTS c2c_plan_acceptance_receipts');
    raw.exec('DROP TABLE c2c_evaluation_receipts');
    raw.exec('PRAGMA user_version = 8');
  } finally {
    raw.close();
  }
}

function downgradeCurrentLedgerToV9(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TABLE IF EXISTS c2c_plan_acceptance_receipts');
    raw.exec('PRAGMA user_version = 9');
  } finally {
    raw.close();
  }
}

function tableExists(path: string, name: string): boolean {
  const raw = new DatabaseSync(path);
  try {
    const row = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { name: string } | undefined;
    return row !== undefined;
  } finally {
    raw.close();
  }
}

function schemaVersion(path: string): number {
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare('PRAGMA user_version').get() as Record<
      string,
      number
    >;
    return Number(Object.values(row)[0]);
  } finally {
    raw.close();
  }
}

function receiptTableColumns(path: string): string[] {
  const raw = new DatabaseSync(path);
  try {
    return (
      raw.prepare('PRAGMA table_info(c2c_evaluation_receipts)').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

function terminalDispatch(taskId: string): DispatchRun {
  const now = new Date().toISOString();
  return {
    id: 'migration-dispatch',
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: 'fixture',
    worker_profile_id: null,
    runner_instance_id: 'runner-migration',
    pid: 123,
    status: 'completed',
    started_at: now,
    finished_at: now,
    exit_code: 0,
    error_code: null,
    error_detail: null,
    created_at: now,
    updated_at: now,
  };
}

function runOpenCurrent(
  dbPath: string,
  repo: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--mode',
        'open-current',
        '--store',
        dbPath,
        '--repo',
        repo,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', (error) =>
      resolve({ code: null, stderr: String(error) }),
    );
  });
}

function runColdV8(
  dbPath: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--mode',
        'cold-v8',
        '--store',
        dbPath,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', (error) =>
      resolve({ code: null, stderr: String(error) }),
    );
  });
}

describe('S3A durable receipt migration across later schema versions', () => {
  it('creates the S3A receipt table on a fresh current-schema ledger', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    expect(schemaVersion(opened.store.path)).toBe(SCHEMA_VERSION);
    expect(receiptTableColumns(opened.store.path)).toEqual([
      'message_id',
      'message_digest',
      'task_id',
      'evaluated_revision',
      'decision',
      'created_at',
    ]);
  });

  it('migrates V8 through S3A V9 to current schema while preserving legacy and S3A data', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    const payload = {
      ...implPayload,
      allowed_scope: ['output.txt'],
      forbidden_scope: [],
      context_files: [],
    };
    const created = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload,
    });
    const running = claimTask(
      opened.store,
      snapshot(repo),
      'JUNIOR',
      'migration-writer',
      created.id,
      created.revision,
    );
    writeFileSync(join(repo, 'output.txt'), 'durable migration data\n');
    const blocked = reportBlocked(
      opened.store,
      'JUNIOR',
      'migration-writer',
      {
        task_id: running.id,
        revision: running.revision,
        blocker: {
          reason: 'VALIDATION_ENVIRONMENT',
          summary: 'checkpoint for migration',
          need_from_owner: 'save state',
          evidence_refs: [],
          changed_files: ['output.txt'],
        },
      },
    );
    const saved = checkpointTask(
      opened.store,
      snapshot(repo),
      {
        task_id: blocked.id,
        revision: blocked.revision,
        purpose: 'RESUME',
      },
    );
    opened.store.transact(() =>
      opened.store.insertDispatchRun(terminalDispatch(created.id)),
    );

    const before = {
      task: opened.store.getTask(created.id),
      events: opened.store.listEvents(created.id),
      dispatches: opened.store.listDispatchRunsForTask(created.id),
      checkpoints: opened.store.listCheckpoints(created.id),
    };
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    downgradeCurrentLedgerToV8(dbPath);
    expect(schemaVersion(dbPath)).toBe(8);

    const migrated = Store.open(dbPath, { repoRoot: repo });
    stores.push(migrated);
    expect(schemaVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(receiptTableColumns(dbPath)).toEqual([
      'message_id',
      'message_digest',
      'task_id',
      'evaluated_revision',
      'decision',
      'created_at',
    ]);
    expect(migrated.getTask(created.id)).toEqual(before.task);
    expect(migrated.listEvents(created.id)).toEqual(before.events);
    expect(migrated.listDispatchRunsForTask(created.id)).toEqual(
      before.dispatches,
    );
    expect(migrated.listCheckpoints(created.id)).toEqual(
      before.checkpoints,
    );
    expect(
      migrated.listCheckpoints(created.id)[0]?.id,
    ).toBe(saved.checkpoint.id);

    const migratedTask = migrated.getTask(created.id);
    if (!migratedTask) throw new Error('migrated task disappeared');
    const message = ownerMessage(migratedTask, 'v8-through-current-receipt');
    expect(
      durableEvaluateC2CMessage(
        migrated,
        message,
        ownerContext(repo),
      ).decision,
    ).toBe('REQUIRES_OWNER_ACTION');
    const receiptBeforeV10 = migrated.getC2CEvaluationReceipt(message.message_id);
    expect(receiptBeforeV10).toBeDefined();

    closeTracked(migrated);
    downgradeCurrentLedgerToV9(dbPath);
    expect(schemaVersion(dbPath)).toBe(9);

    const reopened = Store.open(dbPath, { repoRoot: repo });
    stores.push(reopened);
    expect(schemaVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(reopened.getTask(created.id)).toEqual(before.task);
    expect(reopened.getC2CEvaluationReceipt(message.message_id)).toEqual(
      receiptBeforeV10,
    );
  });

  it('rolls back the V8 to current schema change when S3A receipt storage validation fails', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE IF EXISTS c2c_plan_acceptance_receipts');
    raw.exec('DROP TABLE c2c_evaluation_receipts');
    raw.exec(
      'CREATE TABLE c2c_evaluation_receipts (message_id TEXT PRIMARY KEY) STRICT;',
    );
    raw.exec('PRAGMA user_version = 8');
    raw.close();

    expect(() => Store.open(dbPath, { repoRoot: repo })).toThrow(
      /C2C evaluation receipt table has an unexpected shape/,
    );

    expect(schemaVersion(dbPath)).toBe(8);
    expect(receiptTableColumns(dbPath)).toEqual(['message_id']);
    expect(tableExists(dbPath, 'c2c_plan_acceptance_receipts')).toBe(false);
  });

  it('serializes concurrent V8 to current Store.open migration under BEGIN IMMEDIATE', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeCurrentLedgerToV8(dbPath);

    const results = await Promise.all([
      runOpenCurrent(dbPath, repo),
      runOpenCurrent(dbPath, repo),
      runOpenCurrent(dbPath, repo),
      runOpenCurrent(dbPath, repo),
    ]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('database is locked');
    }

    expect(schemaVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(receiptTableColumns(dbPath)).toHaveLength(6);
  });

  it('fails closed when a cold V8 binary model opens the newer current ledger', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const result = await runColdV8(dbPath);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `Unsupported schema user_version ${SCHEMA_VERSION}; expected 8`,
    );
  });

  it('fences a pre-opened generation-3 V8 writer after current migration while preserving S3A receipts', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeCurrentLedgerToV8(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA foreign_keys = ON');
    const legalUpdate = legacy.prepare(
      "UPDATE tasks SET status = 'CANCELLED', writer_generation = writer_generation + 3, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'READY'",
    );
    const legalEvent = legacy.prepare(
      "INSERT INTO task_events (task_id, at, actor_role, kind, from_status, to_status, revision, detail_json, writer_generation) VALUES (?, ?, 'OWNER', 'cancelled', 'READY', 'CANCELLED', 2, NULL, 3)",
    );
    const illegalUpdate = legacy.prepare(
      "UPDATE tasks SET status = 'CLOSED', writer_generation = writer_generation + 1, revision = revision + 1, updated_at = ? WHERE id = ?",
    );

    const current = Store.open(dbPath, { repoRoot: repo });
    stores.push(current);
    expect(schemaVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);

    const message = ownerMessage(task, 'mixed-version-receipt');
    expect(
      durableEvaluateC2CMessage(
        current,
        message,
        ownerContext(repo),
      ).decision,
    ).toBe('REQUIRES_OWNER_ACTION');
    const receiptBefore = current.getC2CEvaluationReceipt(
      'mixed-version-receipt',
    );
    expect(receiptBefore).toBeDefined();

    const now = new Date().toISOString();
    try {
      expect(() => legalUpdate.run(now, task.id)).toThrow(
        /CURRENT_PROTOCOL_WRITER_REQUIRED/,
      );
      expect(() => legalEvent.run(task.id, now)).toThrow(
        /CURRENT_PROTOCOL_WRITER_REQUIRED/,
      );
      expect(() =>
        illegalUpdate.run(new Date().toISOString(), task.id),
      ).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED/);

      expect(current.getTask(task.id)?.status).toBe('READY');
      expect(current.listEvents(task.id).map((event) => event.kind)).toEqual([
        'created',
      ]);
      expect(
        current.getC2CEvaluationReceipt('mixed-version-receipt'),
      ).toEqual(receiptBefore);
    } finally {
      legacy.close();
    }
  });
});
