import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  implPayload,
  implResult,
  initGitRepo,
  removeDir,
  projectRoot,
  spawnEnv,
  tempDir,
} from './helpers.ts';
import { Store } from '../src/store.ts';
import { DomainError } from '../src/errors.ts';
import type { ProcessRole } from '../src/types.ts';

const LEGACY_COMMIT = '6b38cf4';
const PREVIOUS_RELEASE_COMMIT = 'c41934e17f76e73b38b3817337119178de3154bc';
const dirs: string[] = [];
const legacyDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const legacyProcs: ChildProcess[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const child of legacyProcs.splice(0)) {
    if (!child.killed) child.kill();
  }
  for (const dir of legacyDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

function materializeLegacyV1(): string {
  const dir = mkdtempSync(join(projectRoot, '.legacy-v1-'));
  legacyDirs.push(dir);
  const sourceDir = join(dir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  const files = [
    'db-path.ts',
    'errors.ts',
    'git.ts',
    'index.ts',
    'lifecycle.ts',
    'role.ts',
    'server.ts',
    'store.ts',
    'tools.ts',
    'types.ts',
  ];
  for (const file of files) {
    const content = execFileSync('git', ['show', `${LEGACY_COMMIT}:src/${file}`], {
      encoding: 'utf8',
    });
    writeFileSync(join(sourceDir, file), content);
  }
  writeFileSync(
    join(sourceDir, 'legacy-store-helper.ts'),
    `import { createInterface } from 'node:readline';
import { Store } from './store.ts';

const dbPath = process.argv[2];
const store = Store.open(dbPath);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write('READY\\n');
rl.on('line', (line) => {
  try {
    const request = JSON.parse(line) as {
      task_id: string;
      updates: Record<string, unknown>;
    };
    const task = store.getTask(request.task_id);
    if (!task) {
      console.log(JSON.stringify({ ok: false, error: 'not found' }));
      store.close();
      process.exit(0);
    }
    const next = { ...task, ...request.updates } as never;
    store.updateTask(next);
    console.log(JSON.stringify({ ok: true }));
    store.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ ok: false, error: message }));
    store.close();
    process.exit(0);
  }
});
`,
  );
  return dir;
}

function materializePreviousV6(): string {
  const dir = mkdtempSync(join(projectRoot, '.legacy-v6-'));
  legacyDirs.push(dir);
  const sourceDir = join(dir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  for (const file of ['store.ts', 'types.ts', 'errors.ts']) {
    const content = execFileSync('git', ['show', `${PREVIOUS_RELEASE_COMMIT}:src/${file}`], {
      encoding: 'utf8',
    });
    writeFileSync(join(sourceDir, file), content);
  }
  writeFileSync(
    join(sourceDir, 'legacy-v6-store-helper.ts'),
    `import { createInterface } from 'node:readline';
import { Store } from './store.ts';

const dbPath = process.argv[2];
const repoArg = process.argv[3];
let store: Store;
try {
  store = repoArg ? Store.open(dbPath, { repoRoot: repoArg }) : Store.open(dbPath);
  process.stdout.write('READY' + String.fromCharCode(10));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    const request = JSON.parse(line) as {
      action: string;
      task?: unknown;
      event?: unknown;
      run?: unknown;
      task_id?: string;
      error_code?: string;
      error_detail?: string;
    };
    if (request.action === 'insert') {
      store.transact(() => store.insertTask(request.task as never));
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'update') {
      store.updateTask(request.task as never);
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'insertDispatch') {
      store.transact(() => store.insertDispatchRun(request.run as never));
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'updateDispatch') {
      store.updateDispatchRun(request.run as never);
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'failActiveDispatch') {
      store.failActiveDispatchForTask(request.task_id!, request.error_code!, request.error_detail!);
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'insertEvent') {
      store.transact(() => store.insertEvent(request.event as never));
      process.stdout.write(JSON.stringify({ ok: true }) + String.fromCharCode(10));
    } else if (request.action === 'exit') {
      store.close();
      process.exit(0);
    } else {
      process.stdout.write(JSON.stringify({ ok: false, error: 'unknown action' }) + String.fromCharCode(10));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + String.fromCharCode(10));
  }
});
`,
  );
  return dir;
}

function startLegacyV6StoreHelper(legacySrcDir: string, dbPath: string, repoPath?: string): {
  child: ChildProcess;
  ready: Promise<void>;
  run: (request: unknown) => Promise<{ ok: boolean; error?: string }>;
  close: () => Promise<void>;
} {
  const child = spawn(
    process.execPath,
    [join(legacySrcDir, 'src', 'legacy-v6-store-helper.ts'), dbPath, ...(repoPath ? [repoPath] : [])],
    {
      cwd: projectRoot,
      env: spawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  legacyProcs.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (stdout.includes('READY')) resolve();
      if (child.exitCode !== null) reject(new Error(`legacy v6 helper exited early: ${stderr}`));
    };
    child.stdout?.on('data', check);
    child.on('exit', check);
  });

  const run = (request: unknown) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const onResponse = (chunk: string) => {
        const line = chunk.split(String.fromCharCode(10)).find((item) => item.startsWith('{'));
        if (line) {
          child.stdout?.off('data', onResponse);
          resolve(JSON.parse(line) as { ok: boolean; error?: string });
        }
      };
      child.stdout?.on('data', onResponse);
      child.stdin?.write(JSON.stringify(request) + String.fromCharCode(10));
    });

  const close = async () => {
    if (child.exitCode !== null) return;
    child.stdin?.write(JSON.stringify({ action: 'exit' }) + String.fromCharCode(10));
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  };

  return { child, ready, run, close };
}

function previousV6DispatchRun(id: string, taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id,
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: 'codex-exec-luna',
    runner_instance_id: null,
    pid: null,
    status: 'launching',
    started_at: null,
    finished_at: null,
    exit_code: null,
    error_code: null,
    error_detail: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function previousV6Event(taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    at: '2026-01-01T00:00:00.000Z',
    actor_role: 'OWNER',
    kind: 'created',
    from_status: null,
    to_status: 'READY',
    revision: 1,
  };
}

function previousV6Task(id: string, repoRoot: string, status = 'READY'): Record<string, unknown> {
  return {
    id,
    type: 'IMPLEMENTATION',
    status,
    owner_role: 'OWNER',
    assignee_role: null,
    execution_instance_id: null,
    writer_generation: 1,
    repo_root: repoRoot,
    base_commit: 'aaa',
    branch: 'main',
    payload: implPayload,
    result: null,
    blocker: null,
    revision: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

async function connectLegacyStdio(
  processRole: ProcessRole,
  repoPath: string,
  dbPath: string,
  legacySrcDir: string,
): Promise<{ client: Client; transport: StdioClientTransport; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(legacySrcDir, 'src', 'index.ts'), '--role', processRole, '--repo', repoPath, '--db', dbPath],
    cwd: projectRoot,
    env: spawnEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'legacy-v1-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

function startLegacyStoreHelper(legacySrcDir: string, dbPath: string): {
  child: ChildProcess;
  ready: Promise<void>;
  run: (request: unknown) => Promise<{ ok: boolean; error?: string }>;
} {
  const child = spawn(
    process.execPath,
    [join(legacySrcDir, 'src', 'legacy-store-helper.ts'), dbPath],
    {
      cwd: projectRoot,
      env: spawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  legacyProcs.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (stdout.includes('READY')) resolve();
      if (child.exitCode !== null) reject(new Error(`legacy helper exited early: ${stderr}`));
    };
    child.stdout?.on('data', check);
    child.on('exit', check);
  });

  const run = (request: unknown) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const onExit = () => {
        try {
          const line = stdout.split(String.fromCharCode(10)).find((item) => item.startsWith('{'));
          if (!line) {
            reject(new Error(`legacy helper produced no JSON: ${stderr}`));
            return;
          }
          resolve(JSON.parse(line) as { ok: boolean; error?: string });
        } catch (error) {
          reject(error);
        }
      };
      child.once('exit', onExit);
      child.stdin?.write(JSON.stringify(request) + String.fromCharCode(10));
    });

  return { child, ready, run };
}

function taskText(result: CallToolResult): string {
  const body = structured(result);
  if (body.ok === false) {
    const error = body.error as { code: string; message: string };
    return `${error.code}: ${error.message}`;
  }
  return JSON.stringify(body.task);
}

describe('V1.5.2 mixed-version legacy writer fencing', () => {
  it('fences legacy claim after migration when a legacy process remains alive', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-claim-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    expect(createdTask.id).toBeTruthy();

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);

    const migrated = Store.open(dbPath, { repoRoot: repo });
    migrated.close();

    const claimAttempt = await legacyJunior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimAttempt.isError).toBe(true);
    expect(taskText(claimAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const current = Store.open(dbPath, { repoRoot: repo });
    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('READY');
    expect(after?.execution_instance_id).toBeNull();
    current.close();
  });

  it('fences legacy report_result and report_blocked against a V2-owned task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-report-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);

    const current = Store.open(dbPath, { repoRoot: repo });
    const ready = current.getTask(createdTask.id);
    expect(ready?.status).toBe('READY');
    const running = current.transact(() => {
      const task = current.getTask(createdTask.id);
      if (!task) throw new Error('missing task');
      const next = {
        ...task,
        status: 'RUNNING' as const,
        assignee_role: 'JUNIOR' as const,
        execution_instance_id: 'v152-owner',
        writer_generation: task.writer_generation + 2,
        revision: task.revision + 1,
      };
      current.updateTask(next);
      return next;
    });
    expect(running.status).toBe('RUNNING');

    const reportResultAttempt = await legacyJunior.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: createdTask.id,
        revision: running.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(reportResultAttempt.isError).toBe(true);
    expect(taskText(reportResultAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const reportBlockedAttempt = await legacyJunior.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: createdTask.id,
        revision: running.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'legacy blocked attempt',
          need_from_owner: 'none',
          evidence_refs: [],
        },
      },
    });
    expect(reportBlockedAttempt.isError).toBe(true);
    expect(taskText(reportBlockedAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.execution_instance_id).toBe('v152-owner');

    const completed = current.transact(() => {
      const task = current.getTask(createdTask.id);
      if (!task) throw new Error('missing task');
      const next = {
        ...task,
        status: 'COMPLETED' as const,
        execution_instance_id: null,
        writer_generation: task.writer_generation + 2,
        result: implResult,
        revision: task.revision + 1,
      };
      current.updateTask(next);
      return next;
    });
    expect(completed.status).toBe('COMPLETED');
    current.close();
  });

  it('refuses migration while a legacy RUNNING task exists', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-running-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);
    const claimed = await legacyJunior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimed.isError).toBeFalsy();

    let migrationError: unknown;
    try {
      Store.open(dbPath, { repoRoot: repo });
    } catch (error) {
      migrationError = error;
    }
    expect(migrationError).toBeInstanceOf(DomainError);
    expect((migrationError as DomainError).code).toBe('LEGACY_RUNNING_TASK_PREVENTS_MIGRATION');
  });

  it('fences a pre-opened legacy repo-B connection from creating tasks after repo-A binding', async () => {
    const repoA = initGitRepo();
    const repoB = initGitRepo();
    const dbDir = tempDir('eng-mcp-v153-cross-create-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repoA, repoB, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwnerA = await connectLegacyStdio('owner', repoA, dbPath, legacySrc);
    closers.push(legacyOwnerA.close);
    const legacyOwnerB = await connectLegacyStdio('owner', repoB, dbPath, legacySrc);
    closers.push(legacyOwnerB.close);

    const createdA = await legacyOwnerA.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const taskA = structured(createdA).task as { id: string; repo_root: string };
    expect(taskA.repo_root).toBe(repoA);

    const migrated = Store.open(dbPath, { repoRoot: repoA });
    migrated.close();

    const createByB = await legacyOwnerB.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(createByB.isError).toBe(true);
    expect(taskText(createByB)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const current = Store.open(dbPath, { repoRoot: repoA });
    const active = current.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.repo_root).toBe(repoA);
    expect(active[0]?.id).toBe(taskA.id);
    current.close();
  });

  it('fences a legacy generic RUNNING to RUNNING update through an already-open store', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v153-running-update-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const helper = startLegacyStoreHelper(legacySrc, dbPath);
    await helper.ready;

    const current = Store.open(dbPath, { repoRoot: repo });
    const ready = current.getTask(createdTask.id);
    expect(ready?.status).toBe('READY');
    const running = current.transact(() => {
      const task = current.getTask(createdTask.id);
      if (!task) throw new Error('missing task');
      const next = {
        ...task,
        status: 'RUNNING' as const,
        assignee_role: 'JUNIOR' as const,
        execution_instance_id: 'v153-owner',
        writer_generation: task.writer_generation + 2,
        revision: task.revision + 1,
      };
      current.updateTask(next);
      return next;
    });
    expect(running.status).toBe('RUNNING');

    const result = await helper.run({
      task_id: createdTask.id,
      updates: {
        status: 'RUNNING',
        assignee_role: 'PRINCIPAL',
        base_commit: 'changed-by-legacy',
        revision: running.revision + 1,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.assignee_role).toBe('JUNIOR');
    expect(after?.base_commit).toBe(ready?.base_commit);
    expect(after?.execution_instance_id).toBe('v153-owner');
    expect(after?.revision).toBe(running.revision);
    current.close();
  });

  it('rejects same-repository legacy create_task after migration', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v154-same-create-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(created.isError).toBeFalsy();

    const migrated = Store.open(dbPath, { repoRoot: repo });
    migrated.close();

    const createAfterMigration = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(createAfterMigration.isError).toBe(true);
    expect(taskText(createAfterMigration)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const current = Store.open(dbPath, { repoRoot: repo });
    expect(current.listActive()).toHaveLength(1);
    current.close();
  });

  it('rejects the exact legacy foreign cancel_task blocker after migration', async () => {
    const repoA = initGitRepo();
    const repoB = initGitRepo();
    const dbDir = tempDir('eng-mcp-v154-cancel-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repoA, repoB, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwnerA = await connectLegacyStdio('owner', repoA, dbPath, legacySrc);
    closers.push(legacyOwnerA.close);
    const legacyOwnerB = await connectLegacyStdio('owner', repoB, dbPath, legacySrc);
    closers.push(legacyOwnerB.close);

    const created = await legacyOwnerA.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const task = structured(created).task as { id: string; revision: number };

    const migrated = Store.open(dbPath, { repoRoot: repoA });
    migrated.close();

    const cancelAttempt = await legacyOwnerB.client.callTool({
      name: 'cancel_task',
      arguments: { task_id: task.id, revision: task.revision },
    });
    expect(cancelAttempt.isError).toBe(true);
    expect(taskText(cancelAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const current = Store.open(dbPath, { repoRoot: repoA });
    const after = current.getTask(task.id);
    expect(after?.status).toBe('READY');
    expect(after?.revision).toBe(task.revision);
    current.close();
  });

  it('rejects eligible legacy close_task and resume_task after migration', async () => {
    const repoA = initGitRepo();
    const repoB = initGitRepo();
    const dbDir = tempDir('eng-mcp-v154-close-resume-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repoA, repoB, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwnerA = await connectLegacyStdio('owner', repoA, dbPath, legacySrc);
    closers.push(legacyOwnerA.close);
    const legacyJuniorA = await connectLegacyStdio('junior', repoA, dbPath, legacySrc);
    closers.push(legacyJuniorA.close);
    const legacyOwnerB = await connectLegacyStdio('owner', repoB, dbPath, legacySrc);
    closers.push(legacyOwnerB.close);

    const createdCompleted = await legacyOwnerA.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const completedTask = structured(createdCompleted).task as { id: string; revision: number };
    const claimedCompleted = await legacyJuniorA.client.callTool({
      name: 'claim_task',
      arguments: { task_id: completedTask.id, revision: completedTask.revision },
    });
    const claimedCompletedTask = structured(claimedCompleted).task as { id: string; revision: number };
    const reported = await legacyJuniorA.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: claimedCompletedTask.id,
        revision: claimedCompletedTask.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    const completed = structured(reported).task as { id: string; revision: number };

    const createdBlocked = await legacyOwnerA.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const blockedTask = structured(createdBlocked).task as { id: string; revision: number };
    const claimedBlocked = await legacyJuniorA.client.callTool({
      name: 'claim_task',
      arguments: { task_id: blockedTask.id, revision: blockedTask.revision },
    });
    const claimedBlockedTask = structured(claimedBlocked).task as { id: string; revision: number };
    const blocked = await legacyJuniorA.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: claimedBlockedTask.id,
        revision: claimedBlockedTask.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'pre-migration blocked',
          need_from_owner: 'review',
          evidence_refs: [],
        },
      },
    });
    const blockedTaskFinal = structured(blocked).task as { id: string; revision: number };

    const migrated = Store.open(dbPath, { repoRoot: repoA });
    migrated.close();

    const closeAttempt = await legacyOwnerB.client.callTool({
      name: 'close_task',
      arguments: { task_id: completed.id, revision: completed.revision },
    });
    expect(closeAttempt.isError).toBe(true);
    expect(taskText(closeAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const resumeAttempt = await legacyOwnerA.client.callTool({
      name: 'resume_task',
      arguments: { task_id: blockedTaskFinal.id, revision: blockedTaskFinal.revision },
    });
    expect(resumeAttempt.isError).toBe(true);
    expect(taskText(resumeAttempt)).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

    const current = Store.open(dbPath, { repoRoot: repoA });
    expect(current.getTask(completed.id)?.status).toBe('COMPLETED');
    expect(current.getTask(blockedTaskFinal.id)?.status).toBe('BLOCKED');
    current.close();
  });
});

describe('V1.8-A previous release writer fencing', () => {
  it('cold previous V6 writer cannot open a V7 ledger', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v6-cold-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const current = Store.open(dbPath, { repoRoot: repo });
    current.close();

    const legacySrc = materializePreviousV6();
    const child = spawn(
      process.execPath,
      [join(legacySrc, 'src', 'legacy-v6-store-helper.ts'), dbPath, repo],
      {
        cwd: projectRoot,
        env: spawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
      child.on('error', () => resolve(null));
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain('Unsupported schema user_version');

    const verify = Store.open(dbPath, { repoRoot: repo });
    verify.close();
  });

  it('pre-opened previous V6 writer cannot INSERT or UPDATE after V7 migration', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v6-prewarmed-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const legacySrc = materializePreviousV6();
    const helper = startLegacyV6StoreHelper(legacySrc, dbPath, repo);
    await helper.ready;
    try {
      const inserted = await helper.run({ action: 'insert', task: previousV6Task('v6-task-a', repo) });
      expect(inserted.ok).toBe(true);

      const migrated = Store.open(dbPath, { repoRoot: repo });
      expect(migrated.getTask('v6-task-a')?.repo_root).toBe(repo);
      migrated.close();

      const insertAfter = await helper.run({ action: 'insert', task: previousV6Task('v6-task-b', repo) });
      expect(insertAfter.ok).toBe(false);
      expect(insertAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const updateAfter = await helper.run({
        action: 'update',
        task: {
          ...previousV6Task('v6-task-a', repo, 'RUNNING'),
          assignee_role: 'JUNIOR',
          execution_instance_id: 'v6-writer',
          writer_generation: 2,
          revision: 2,
        },
      });
      expect(updateAfter.ok).toBe(false);
      expect(updateAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const verify = Store.open(dbPath, { repoRoot: repo });
      expect(verify.getTask('v6-task-a')?.status).toBe('READY');
      expect(verify.getTask('v6-task-a')?.writer_generation).toBe(1);
      expect(verify.getTask('v6-task-a')?.execution_instance_id).toBeNull();
      expect(verify.getTask('v6-task-b')).toBeUndefined();
      verify.close();
    } finally {
      await helper.close();
    }
  });

  it('pre-opened previous V6 writer cannot mutate dispatch_runs or task_events after V7 migration', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v6-dispatch-event-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const legacySrc = materializePreviousV6();
    const helper = startLegacyV6StoreHelper(legacySrc, dbPath, repo);
    await helper.ready;
    try {
      const taskInserted = await helper.run({ action: 'insert', task: previousV6Task('v6-dispatch-task', repo) });
      expect(taskInserted.ok).toBe(true);

      const dispatchInserted = await helper.run({
        action: 'insertDispatch',
        run: previousV6DispatchRun('v6-dispatch-existing', 'v6-dispatch-task'),
      });
      expect(dispatchInserted.ok).toBe(true);

      const eventInserted = await helper.run({ action: 'insertEvent', event: previousV6Event('v6-dispatch-task') });
      expect(eventInserted.ok).toBe(true);

      const migrated = Store.open(dbPath, { repoRoot: repo });
      migrated.close();

      const insertDispatchAfter = await helper.run({
        action: 'insertDispatch',
        run: previousV6DispatchRun('v6-dispatch-forged', 'v6-dispatch-task'),
      });
      expect(insertDispatchAfter.ok).toBe(false);
      expect(insertDispatchAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const updateDispatchAfter = await helper.run({
        action: 'updateDispatch',
        run: previousV6DispatchRun('v6-dispatch-existing', 'v6-dispatch-task', {
          pid: 999,
          status: 'running',
          started_at: '2026-01-01T00:00:00.000Z',
          error_detail: 'forged',
        }),
      });
      expect(updateDispatchAfter.ok).toBe(false);
      expect(updateDispatchAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const failActiveAfter = await helper.run({
        action: 'failActiveDispatch',
        task_id: 'v6-dispatch-task',
        error_code: 'FORGED',
        error_detail: 'forged by v6',
      });
      expect(failActiveAfter.ok).toBe(false);
      expect(failActiveAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const insertEventAfter = await helper.run({ action: 'insertEvent', event: previousV6Event('v6-dispatch-task') });
      expect(insertEventAfter.ok).toBe(false);
      expect(insertEventAfter.error).toContain('CURRENT_PROTOCOL_WRITER_REQUIRED');

      const verify = Store.open(dbPath, { repoRoot: repo });
      const existing = verify.getDispatchRun('v6-dispatch-existing');
      expect(existing?.status).toBe('launching');
      expect(existing?.pid).toBeNull();
      expect(verify.getDispatchRun('v6-dispatch-forged')).toBeUndefined();
      expect(verify.listEvents('v6-dispatch-task')).toHaveLength(1);
      verify.close();
    } finally {
      await helper.close();
    }
  });
});
