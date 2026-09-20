import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { Store } from '../src/store.ts';
import { createTask } from '../src/lifecycle.ts';
import {
  SCHEMA_VERSION,
  WRITER_PROTOCOL_GENERATION,
} from '../src/types.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-plan-acceptance-worker.ts', import.meta.url),
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

function downgradeToV9(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TABLE IF EXISTS c2c_delegation_receipts');
    raw.exec('DROP TABLE c2c_plan_acceptance_receipts');
    raw.exec('PRAGMA user_version = 9');
  } finally {
    raw.close();
  }
}

function tableExists(path: string, name: string): boolean {
  const raw = new DatabaseSync(path);
  try {
    return raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined;
  } finally {
    raw.close();
  }
}

function version(path: string): number {
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare('PRAGMA user_version').get() as Record<string, number>;
    return Number(Object.values(row)[0]);
  } finally {
    raw.close();
  }
}

function acceptanceColumns(path: string): string[] {
  const raw = new DatabaseSync(path);
  try {
    return (
      raw.prepare('PRAGMA table_info(c2c_plan_acceptance_receipts)').all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

function run(mode: 'open-current' | 'cold-v9', path: string, repo?: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--mode',
        mode,
        '--store',
        path,
        ...(repo ? ['--repo', repo] : []),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', (error) => resolve({ code: null, stderr: String(error) }));
  });
}

describe('S3B1 acceptance migration across later schema versions', () => {
  it('uses the normalized three-column acceptance table on the current ledger', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    expect(version(opened.store.path)).toBe(SCHEMA_VERSION);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    expect(acceptanceColumns(opened.store.path)).toEqual([
      'command_id',
      'evaluation_message_id',
      'accepted_at',
    ]);
  });

  it('migrates V9 through S3B1 V10 to current schema while preserving S3A receipts and task data', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const message = {
      protocol_version: 'engineering-c2c/1' as const,
      message_id: 'persisted-eval',
      task_id: task.id,
      sender_role: 'OWNER' as const,
      state: 'PLAN' as const,
      expected_revision: task.revision,
    };
    expect(
      durableEvaluateC2CMessage(
        opened.store,
        message,
        { actor_role: 'OWNER', repo_root: repo },
      ).decision,
    ).toBe('REQUIRES_OWNER_ACTION');
    const beforeTask = opened.store.getTask(task.id);
    const beforeEval = opened.store.getC2CEvaluationReceipt(message.message_id);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    downgradeToV9(dbPath);
    expect(version(dbPath)).toBe(9);

    const migrated = Store.open(dbPath, { repoRoot: repo });
    stores.push(migrated);
    expect(version(dbPath)).toBe(SCHEMA_VERSION);
    expect(migrated.getTask(task.id)).toEqual(beforeTask);
    expect(migrated.getC2CEvaluationReceipt(message.message_id)).toEqual(beforeEval);
    expect(migrated.getPlanAcceptanceReceipt('none')).toBeUndefined();
  });

  it('rolls back malformed V9 to current migration atomically', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE IF EXISTS c2c_delegation_receipts');
    raw.exec('DROP TABLE c2c_plan_acceptance_receipts');
    raw.exec(
      'CREATE TABLE c2c_plan_acceptance_receipts (command_id TEXT PRIMARY KEY) STRICT;',
    );
    raw.exec('PRAGMA user_version = 9');
    raw.close();

    expect(() => Store.open(dbPath, { repoRoot: repo })).toThrow(
      /plan acceptance receipt table has an unexpected shape/i,
    );
    expect(version(dbPath)).toBe(9);
    expect(acceptanceColumns(dbPath)).toEqual(['command_id']);
    expect(tableExists(dbPath, 'c2c_delegation_receipts')).toBe(false);
  });

  it('serializes concurrent V9 to current opens', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeToV9(dbPath);

    const results = await Promise.all([
      run('open-current', dbPath, repo),
      run('open-current', dbPath, repo),
      run('open-current', dbPath, repo),
      run('open-current', dbPath, repo),
    ]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('database is locked');
    }
    expect(version(dbPath)).toBe(SCHEMA_VERSION);
  });

  it('fails closed for a cold V9 binary model on the newer current ledger', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const result = await run('cold-v9', dbPath);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `Unsupported schema user_version ${SCHEMA_VERSION}; expected 9`,
    );
  });

  it('fences a pre-opened generation-3 V9 writer after current migration while preserving S3B1 acceptance', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeToV9(dbPath);

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
    current.insertC2CEvaluationReceipt({
      message_id: 'v9-eval',
      message_digest: 'a'.repeat(64),
      task_id: task.id,
      evaluated_revision: task.revision,
      decision: 'REQUIRES_OWNER_ACTION',
      created_at: new Date().toISOString(),
    });
    current.insertPlanAcceptanceReceipt({
      command_id: 'v10-accept',
      evaluation_message_id: 'v9-eval',
      accepted_at: new Date().toISOString(),
    });
    const receiptBefore = current.getPlanAcceptanceReceipt('v10-accept');

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
      expect(current.getPlanAcceptanceReceipt('v10-accept')).toEqual(
        receiptBefore,
      );
    } finally {
      legacy.close();
    }
  });
});
