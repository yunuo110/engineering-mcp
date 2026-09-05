import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initGitRepo, removeDir, tempDir } from './helpers.ts';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/types.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

const fixture = fileURLToPath(new URL('./fixtures/store-open-fixture.ts', import.meta.url));

function runStoreOpen(dbPath: string, repo: string, mode = 'open', holdMs = '8000'): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fixture,
      '--store',
      dbPath,
      '--repo',
      repo,
      '--mode',
      mode,
      '--holdMs',
      holdMs,
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), shell: false, windowsHide: true });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
}
function runStoreOpenCapture(dbPath: string, repo: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fixture,
      '--store',
      dbPath,
      '--repo',
      repo,
      '--mode',
      'open',
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', () => resolve({ code: null, stderr }));
  });
}
function createV5Ledger(dbPath: string, repo: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      assignee_role TEXT,
      execution_instance_id TEXT,
      writer_generation INTEGER,
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
    CREATE TRIGGER trg_tasks_execution_invariant_insert BEFORE INSERT ON tasks BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
      WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
         OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
    END;
    CREATE TRIGGER trg_tasks_execution_invariant_update BEFORE UPDATE ON tasks BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
      WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
         OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
    END;
    CREATE TRIGGER trg_tasks_repository_invariant_insert BEFORE INSERT ON tasks BEGIN
      SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
      WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
         OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
    END;
    CREATE TRIGGER trg_tasks_repository_invariant_update BEFORE UPDATE ON tasks BEGIN
      SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
      WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
         OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
    END;
    CREATE TRIGGER trg_tasks_running_immutable_update BEFORE UPDATE ON tasks
    WHEN OLD.status = 'RUNNING' AND NEW.status = 'RUNNING' BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION');
    END;
    CREATE TRIGGER trg_tasks_writer_protocol_insert BEFORE INSERT ON tasks BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != 1;
    END;
    CREATE TRIGGER trg_tasks_writer_protocol_update BEFORE UPDATE ON tasks BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != OLD.writer_generation + 1;
    END;
  `);
  raw.prepare(`INSERT INTO ledger_metadata (key, value) VALUES ('repository_root', ?)`).run(repo);
  raw.prepare(`
    INSERT INTO tasks (
      id, type, status, owner_role, assignee_role, execution_instance_id, writer_generation,
      repo_root, base_commit, branch, payload_json, result_json, blocker_json,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'v5-concurrent-task',
    'IMPLEMENTATION',
    'READY',
    'OWNER',
    null,
    null,
    1,
    repo,
    '0000000000000000000000000000000000000000',
    'master',
    JSON.stringify({ goal: 'upgrade race', parent_intent: 'v5->v6', allowed_scope: [], forbidden_scope: [], acceptance_criteria: [], validation_requirements: [], context_files: [], knowledge_refs: [], parent_risk: 'L1' }),
    null,
    null,
    1,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  raw.exec(`PRAGMA user_version = 5`);
  raw.close();
}

describe('concurrent SQLite startup', () => {
  it('allows simultaneous fresh-ledger startup', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const dbDir = tempDir('eng-mcp-start-fresh-');
    dirs.push(dbDir);
    const dbPath = join(dbDir, 'ledger.sqlite');

    const codes = await Promise.all([
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
    ]);
    expect(codes.every((code) => code === 0)).toBe(true);

    const store = Store.open(dbPath, { repoRoot: repo });
    expect(store.repositoryRoot).toBe(repo);
    store.close();
  });

  it('allows simultaneous current-schema startup', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const dbDir = tempDir('eng-mcp-start-current-');
    dirs.push(dbDir);
    const dbPath = join(dbDir, 'ledger.sqlite');
    const initial = Store.open(dbPath, { repoRoot: repo });
    initial.close();

    const codes = await Promise.all([
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
    ]);
    expect(codes.every((code) => code === 0)).toBe(true);
  });

  it('fails closed when another process holds the write lock beyond the busy timeout', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const dbDir = tempDir('eng-mcp-start-lock-');
    dirs.push(dbDir);
    const dbPath = join(dbDir, 'ledger.sqlite');
    const initial = Store.open(dbPath, { repoRoot: repo });
    initial.close();

    const holder = runStoreOpen(dbPath, repo, 'hold-lock', '8000');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startTime = Date.now();
    const code = await runStoreOpen(dbPath, repo, 'open', '0');
    const elapsed = Date.now() - startTime;
    expect(code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    const holderCode = await holder;
    expect(holderCode).toBe(0);
  });

  it('creates current schema after fresh concurrent startup', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const dbDir = tempDir('eng-mcp-start-schema-');
    dirs.push(dbDir);
    const dbPath = join(dbDir, 'ledger.sqlite');
    await Promise.all([
      runStoreOpen(dbPath, repo),
      runStoreOpen(dbPath, repo),
    ]);
    const store = Store.open(dbPath, { repoRoot: repo });
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const version = Object.values(raw.prepare('PRAGMA user_version').get() as Record<string, number>)[0];
    raw.close();
    expect(version).toBe(SCHEMA_VERSION);
  });
it('migrates a valid v5 ledger concurrently to v6 without lock failures', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const dbDir = tempDir('eng-mcp-start-v5-');
    dirs.push(dbDir);
    const dbPath = join(dbDir, 'ledger.sqlite');
    createV5Ledger(dbPath, repo);

    const results = await Promise.all([
      runStoreOpenCapture(dbPath, repo),
      runStoreOpenCapture(dbPath, repo),
      runStoreOpenCapture(dbPath, repo),
      runStoreOpenCapture(dbPath, repo),
    ]);

    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('database is locked');
    }

    const store = Store.open(dbPath, { repoRoot: repo });
    expect(store.repositoryRoot).toBe(repo);
    expect(store.getTask('v5-concurrent-task')?.writer_generation).toBe(1);
    expect(store.getTask('v5-concurrent-task')?.status).toBe('READY');
    store.close();

    const raw = new DatabaseSync(dbPath);
    const version = Object.values(raw.prepare('PRAGMA user_version').get() as Record<string, number>)[0];
    const dispatchTable = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_runs'`).get();
    const dispatchIndex = raw.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='one_active_dispatch_per_task'`).get();
    const writerTrigger = raw.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_tasks_writer_protocol_update'`).get();
    raw.close();
    expect(version).toBe(SCHEMA_VERSION);
    expect(dispatchTable).toBeTruthy();
    expect(dispatchIndex).toBeTruthy();
    expect(writerTrigger).toBeTruthy();
  });
});
