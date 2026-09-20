import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { createTask } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import {
  SCHEMA_VERSION,
  WRITER_PROTOCOL_GENERATION,
  type DispatchRun,
} from '../src/types.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-delegation-intent-worker.ts', import.meta.url),
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

function version(path: string): number {
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare('PRAGMA user_version').get() as Record<string, number>;
    return Number(Object.values(row)[0]);
  } finally {
    raw.close();
  }
}

function delegationColumns(path: string): string[] {
  const raw = new DatabaseSync(path);
  try {
    return (
      raw.prepare('PRAGMA table_info(c2c_delegation_receipts)').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

function downgradeToV10(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TABLE c2c_delegation_receipts');
    raw.exec('PRAGMA user_version = 10');
  } finally {
    raw.close();
  }
}

function run(
  mode: 'open-current' | 'cold-v10',
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

function makeAcceptance(
  store: Store,
  repo: string,
  taskId: string,
  revision: number,
): string {
  const message = {
    protocol_version: 'engineering-c2c/1' as const,
    message_id: 'migration-plan-' + taskId,
    task_id: taskId,
    sender_role: 'OWNER' as const,
    state: 'PLAN' as const,
    expected_revision: revision,
    goal: 'migration',
  };
  expect(
    durableEvaluateC2CMessage(
      store,
      message,
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('REQUIRES_OWNER_ACTION');
  const acceptanceCommandId = 'accept-' + taskId;
  expect(
    acceptEvaluatedPlan(
      store,
      { command_id: acceptanceCommandId, plan_message: message },
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('ACCEPTED');
  return acceptanceCommandId;
}

function launchingDispatch(
  id: string,
  taskId: string,
  workerProfileId: string | null = 'codex-luna',
): DispatchRun {
  const now = new Date().toISOString();
  return {
    id,
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: 'codex-exec-luna',
    worker_profile_id: workerProfileId,
    runner_instance_id: null,
    pid: null,
    status: 'launching',
    started_at: null,
    finished_at: null,
    exit_code: null,
    error_code: null,
    error_detail: null,
    created_at: now,
    updated_at: now,
  };
}

describe('S3B2A delegation-intent migration across later schema versions', () => {
  it('creates the normalized delegation table on a fresh current-schema ledger', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    expect(SCHEMA_VERSION).toBe(12);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    expect(version(opened.store.path)).toBe(SCHEMA_VERSION);
    expect(delegationColumns(opened.store.path)).toEqual([
      'command_id',
      'acceptance_command_id',
      'dispatch_run_id',
      'launch_spec_json',
      'created_at',
    ]);
  });

  it('migrates V10 through S3B2A V11 to current schema while preserving prior data', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const acceptanceId = makeAcceptance(
      opened.store,
      repo,
      task.id,
      task.revision,
    );
    const beforeTask = opened.store.getTask(task.id);
    const beforeAcceptance =
      opened.store.getPlanAcceptanceReceipt(acceptanceId);
    const beforeEvaluation =
      opened.store.getC2CEvaluationReceipt('migration-plan-' + task.id);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    downgradeToV10(dbPath);
    expect(version(dbPath)).toBe(10);

    const migrated = Store.open(dbPath, { repoRoot: repo });
    stores.push(migrated);
    expect(version(dbPath)).toBe(SCHEMA_VERSION);
    expect(migrated.getTask(task.id)).toEqual(beforeTask);
    expect(migrated.getPlanAcceptanceReceipt(acceptanceId)).toEqual(
      beforeAcceptance,
    );
    expect(
      migrated.getC2CEvaluationReceipt('migration-plan-' + task.id),
    ).toEqual(beforeEvaluation);
    expect(
      migrated.getC2CDelegationIntentReceipt('none'),
    ).toBeUndefined();
  });

  it('rolls back malformed V10 to V11 delegation storage atomically', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE c2c_delegation_receipts');
    raw.exec(
      'CREATE TABLE c2c_delegation_receipts (command_id TEXT PRIMARY KEY) STRICT;',
    );
    raw.exec('PRAGMA user_version = 10');
    raw.close();

    expect(() => Store.open(dbPath, { repoRoot: repo })).toThrow(
      /C2C delegation receipt table has an unexpected shape/i,
    );
    expect(version(dbPath)).toBe(10);
    expect(delegationColumns(dbPath)).toEqual(['command_id']);
  });

  it('serializes concurrent V10 to current Store.open migration', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeToV10(dbPath);

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

  it('fails closed for a cold V10 binary model on the newer current ledger', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    closeTracked(opened.store);

    const result = await run('cold-v10', dbPath);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `Unsupported schema user_version ${SCHEMA_VERSION}; expected 10`,
    );
  });

  it('fences a pre-opened V10 generation-3 dispatch writer after current migration without corrupting S3B2A data', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);

    const c2cTask = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const ordinaryTask = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const acceptanceId = makeAcceptance(
      opened.store,
      repo,
      c2cTask.id,
      c2cTask.revision,
    );
    const dbPath = opened.store.path;
    closeTracked(opened.store);
    downgradeToV10(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA foreign_keys = ON');
    const legalDispatch = legacy.prepare(
      "INSERT INTO dispatch_runs (id, task_id, worker_role, adapter_id, worker_profile_id, writer_generation, runner_instance_id, pid, status, started_at, finished_at, exit_code, error_code, error_detail, created_at, updated_at) VALUES (?, ?, 'JUNIOR', 'legacy-ordinary', NULL, 3, NULL, NULL, 'launching', NULL, NULL, NULL, NULL, NULL, ?, ?)",
    );
    const illegalDispatch = legacy.prepare(
      "INSERT INTO dispatch_runs (id, task_id, worker_role, adapter_id, worker_profile_id, writer_generation, runner_instance_id, pid, status, started_at, finished_at, exit_code, error_code, error_detail, created_at, updated_at) VALUES (?, ?, 'JUNIOR', 'legacy-illegal', NULL, 1, NULL, NULL, 'failed', NULL, ?, NULL, 'x', 'x', ?, ?)",
    );

    const current = Store.open(dbPath, { repoRoot: repo });
    stores.push(current);
    current.insertDispatchRun(
      launchingDispatch('v11-c2c-dispatch', c2cTask.id),
    );
    current.insertC2CDelegationIntentReceipt({
      command_id: 'v11-c2c-command',
      acceptance_command_id: acceptanceId,
      dispatch_run_id: 'v11-c2c-dispatch',
      launch_spec: {
        schema: 'engineering-launch/1',
        platform: 'win32',
        launcher: {
          kind: 'native',
          executable_path: 'C:\\trusted\\codex.exe',
          executable_sha256: 'a'.repeat(64),
        },
        argv_template: [
          'exec',
          '--model',
          'gpt-5.6-luna',
          '-C',
          '${task_repo_root}',
          '-s',
          'workspace-write',
          '--json',
          '--ephemeral',
          '--output-last-message',
          '${dispatch_run_dir}/last-message.txt',
          '-',
        ],
        working_directory_policy: 'task_repo_root',
        prompt_contract: 'engineering-codex-luna-prompt/1',
        prompt_transport: 'stdin',
        result_contract: 'engineering-codex-luna-last-message/1',
        credential_policy: 'inherit-trusted-runtime-environment',
      },
      created_at: new Date().toISOString(),
    });
    const before =
      current.getC2CDelegationIntentReceipt('v11-c2c-command');

    const now = new Date().toISOString();
    try {
      expect(() =>
        legalDispatch.run(
          'legacy-ordinary-dispatch',
          ordinaryTask.id,
          now,
          now,
        ),
      ).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED/);

      expect(() =>
        illegalDispatch.run(
          'legacy-illegal-dispatch',
          ordinaryTask.id,
          now,
          now,
          now,
        ),
      ).toThrow(/CURRENT_PROTOCOL_WRITER_REQUIRED/);

      expect(
        current.getC2CDelegationIntentReceipt('v11-c2c-command'),
      ).toEqual(before);
      expect(current.getDispatchRun('legacy-ordinary-dispatch')).toBeUndefined();
    } finally {
      legacy.close();
    }
  });
});
