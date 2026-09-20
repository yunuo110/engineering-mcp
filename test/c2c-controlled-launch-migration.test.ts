import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { createTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type {
  AdapterContext,
  WorkerAdapter,
  WorkerResult,
} from '../src/orchestration/types.ts';
import { Store } from '../src/store.ts';
import {
  SCHEMA_VERSION,
  WRITER_PROTOCOL_GENERATION,
} from '../src/types.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  tempDir,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-controlled-migration-worker.ts', import.meta.url),
);

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function version(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
    return Number(Object.values(row)[0]);
  } finally {
    db.close();
  }
}

function installV11WriterTriggers(db: DatabaseSync): void {
  db.exec([
    "DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_insert;",
    "DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_update;",
    "DROP TRIGGER IF EXISTS trg_task_events_writer_protocol_insert;",
    "DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_insert;",
    "DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_update;",
    "CREATE TRIGGER trg_tasks_writer_protocol_insert BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED') WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != 3; END;",
    "CREATE TRIGGER trg_tasks_writer_protocol_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED') WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != OLD.writer_generation + 3; END;",
    "CREATE TRIGGER trg_task_events_writer_protocol_insert BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED') WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != 3; END;",
    "CREATE TRIGGER trg_dispatch_runs_writer_protocol_insert BEFORE INSERT ON dispatch_runs BEGIN SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED') WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != 3; END;",
    "CREATE TRIGGER trg_dispatch_runs_writer_protocol_update BEFORE UPDATE ON dispatch_runs BEGIN SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED') WHERE NEW.writer_generation IS NULL OR NEW.writer_generation != OLD.writer_generation + 3; END;",
  ].join('\n'));
}

function downgradeCurrentToV11(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec([
      "DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_insert;",
      "DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_update;",
      "DROP TRIGGER IF EXISTS trg_task_events_writer_protocol_insert;",
      "DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_insert;",
      "DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_update;",
      "UPDATE tasks SET writer_generation = 3;",
      "UPDATE task_events SET writer_generation = 3;",
      "UPDATE dispatch_runs SET writer_generation = 3;",
    ].join('\n'));
    installV11WriterTriggers(db);
    db.exec('PRAGMA user_version = 11');
  } finally {
    db.close();
  }
}

function runChild(
  mode: 'open-current' | 'cold-v11',
  path: string,
  repo?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
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
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', (error) =>
      resolve({ code: null, stderr: String(error) }),
    );
  });
}

function nativeExe(): string {
  const dir = tempDir('eng-mcp-b2b-migration-exe-');
  dirs.push(dir);
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, 'migration-codex-artifact', 'utf8');
  return exe;
}

function makeReservedC2CTask(store: Store, repo: string) {
  const task = createTask(store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload: implPayload,
  });
  const message = {
    protocol_version: 'engineering-c2c/1' as const,
    message_id: 'migration-b2b-plan-' + task.id,
    task_id: task.id,
    sender_role: 'OWNER' as const,
    state: 'PLAN' as const,
    expected_revision: task.revision,
    goal: 'migration fence',
  };
  expect(
    durableEvaluateC2CMessage(
      store,
      message,
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('REQUIRES_OWNER_ACTION');

  const acceptance = 'migration-b2b-accept-' + task.id;
  expect(
    acceptEvaluatedPlan(
      store,
      { command_id: acceptance, plan_message: message },
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('ACCEPTED');

  const exe = nativeExe();
  const intent = createAcceptedDispatchIntent(
    store,
    {
      command_id: 'migration-b2b-delegate-' + task.id,
      acceptance_command_id: acceptance,
      worker_profile_id: 'codex-luna',
    },
    { actor_role: 'OWNER', repo_root: repo },
    builtinWorkerProfiles(),
    {
      launchSpecBuildOptions: {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    },
  );
  expect(intent.decision).toBe('CREATED');
  if (intent.decision !== 'CREATED') throw new Error('intent setup failed');
  return { task, dispatchId: intent.receipt.dispatch_run_id };
}

class CompleteAdapter implements WorkerAdapter {
  readonly id = 'ordinary-v12-test';
  async probe(): Promise<void> {}
  async execute(_context: AdapterContext): Promise<WorkerResult> {
    return {
      outcome: 'completed',
      summary: 'ordinary generation-4 delegation completed',
      changed_files: [],
      validation: [],
      known_limitations: [],
      exit_code: 0,
    };
  }
}

describe('S3B2B V12 generation-4 migration and mixed-version fencing', () => {
  it('uses schema V12 and writer generation 4 on a fresh ledger', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    expect(SCHEMA_VERSION).toBe(12);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    expect(version(opened.store.path)).toBe(12);
  });

  it('rejects the SAME pre-open V11 prepared generation-3 READY→RUNNING claim statement after another connection migrates to V12', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    const { task, dispatchId } = makeReservedC2CTask(opened.store, repo);
    const dbPath = opened.store.path;
    opened.store.close();
    stores.splice(stores.indexOf(opened.store), 1);

    downgradeCurrentToV11(dbPath);
    expect(version(dbPath)).toBe(11);

    const legacy = new DatabaseSync(dbPath);
    const prepared = legacy.prepare(
      "UPDATE tasks SET status = 'RUNNING', assignee_role = 'JUNIOR', execution_instance_id = 'legacy-v11-worker', revision = revision + 1, writer_generation = writer_generation + 3, updated_at = 'legacy' WHERE id = ?",
    );

    const migrated = Store.open(dbPath, { repoRoot: repo });
    stores.push(migrated);
    expect(version(dbPath)).toBe(12);

    expect(() => prepared.run(task.id)).toThrow(
      /CURRENT_PROTOCOL_WRITER_REQUIRED/,
    );

    expect(migrated.getTask(task.id)).toMatchObject({
      status: 'READY',
      revision: task.revision,
      execution_instance_id: null,
    });
    expect(migrated.getDispatchRun(dispatchId)).toMatchObject({
      status: 'launching',
      runner_instance_id: null,
    });
    expect(
      migrated.getC2CDelegationIntentForDispatch(dispatchId),
    ).toBeDefined();

    legacy.close();
  });

  it('cold V11 binary model fails closed on V12', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    opened.store.close();
    downgradeCurrentToV11(dbPath);

    const current = Store.open(dbPath, { repoRoot: repo });
    current.close();

    const result = await runChild('cold-v11', dbPath);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'Unsupported schema user_version 12; expected 11',
    );
  });

  it('serializes concurrent V11→V12 opens and installs generation-4 fences once', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    opened.store.close();
    downgradeCurrentToV11(dbPath);

    const results = await Promise.all([
      runChild('open-current', dbPath, repo),
      runChild('open-current', dbPath, repo),
      runChild('open-current', dbPath, repo),
      runChild('open-current', dbPath, repo),
    ]);

    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('database is locked');
    }
    expect(version(dbPath)).toBe(12);
  });

  it('new V12 ordinary non-C2C delegation remains fully functional under generation 4', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    expect(task.writer_generation).toBe(4);

    const run = await delegateTask(
      opened.store,
      snapshot(repo),
      task.id,
      task.revision,
      {
        adapterId: 'ordinary-v12-test',
        inProcess: true,
        executionInstanceId: 'ordinary-v12-runner',
        adapter: new CompleteAdapter(),
      },
    );

    expect(run.status).toBe('completed');
    expect(opened.store.getTask(task.id)).toMatchObject({
      status: 'COMPLETED',
      execution_instance_id: null,
    });
  });
});
