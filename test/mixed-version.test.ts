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
          const line = stdout.split('\n').find((item) => item.startsWith('{'));
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
      child.stdin?.write(`${JSON.stringify(request)}\n`);
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
    expect(taskText(claimAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

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
    expect(taskText(reportResultAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

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
    expect(taskText(reportBlockedAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

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
    expect(taskText(createByB)).toContain('REPOSITORY_BINDING_MISMATCH');

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
    expect(result.error).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.assignee_role).toBe('JUNIOR');
    expect(after?.base_commit).toBe(ready?.base_commit);
    expect(after?.execution_instance_id).toBe('v153-owner');
    expect(after?.revision).toBe(running.revision);
    current.close();
  });
});
