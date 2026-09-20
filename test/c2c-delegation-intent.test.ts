import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import {
  claimTask,
  createTask,
  reportBlocked,
  resumeTask,
} from '../src/lifecycle.ts';
import { delegateTask, waitForDispatch } from '../src/orchestration/dispatcher.ts';
import { Store } from '../src/store.ts';
import { builtinWorkerProfiles, type WorkerProfiles } from '../src/worker-profiles.ts';
import type { C2CMessage, TrustedActorContext } from '../src/c2c/schema.ts';
import type { TaskContract } from '../src/types.ts';
import {
  diagnosisPayload,
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  tempDir,
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

function owner(repo: string): TrustedActorContext {
  return { actor_role: 'OWNER', repo_root: repo };
}

function nativeExe(content = 'codex-native-v1'): string {
  const dir = tempDir('eng-mcp-c2c-native-');
  dirs.push(dir);
  const path = join(dir, 'codex.exe');
  writeFileSync(path, content, 'utf8');
  return path;
}

function launchOptions(exe: string) {
  return {
    launchSpecBuildOptions: {
      platform: 'win32' as const,
      env: {},
      resolveLauncher: () => ({
        kind: 'native' as const,
        executable: exe,
        displayPath: exe,
      }),
    },
  };
}

function plan(task: TaskContract, id: string): C2CMessage {
  return {
    protocol_version: 'engineering-c2c/1',
    message_id: id,
    task_id: task.id,
    sender_role: 'OWNER',
    state: 'PLAN',
    expected_revision: task.revision,
    goal: 'delegate accepted plan',
  };
}

function acceptPlan(
  store: Store,
  repo: string,
  task: TaskContract,
  id: string,
): { message: C2CMessage; acceptanceCommandId: string } {
  const message = plan(task, id);
  expect(
    durableEvaluateC2CMessage(store, message, owner(repo)).decision,
  ).toBe('REQUIRES_OWNER_ACTION');
  const acceptanceCommandId = 'accept-' + id;
  expect(
    acceptEvaluatedPlan(
      store,
      { command_id: acceptanceCommandId, plan_message: message },
      owner(repo),
    ).decision,
  ).toBe('ACCEPTED');
  return { message, acceptanceCommandId };
}

function setupImplementation() {
  const repo = initGitRepo();
  const opened = openTempStore(repo);
  dirs.push(repo, opened.dir);
  stores.push(opened.store);
  const task = createTask(opened.store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload: implPayload,
  });
  const accepted = acceptPlan(opened.store, repo, task, 'plan-' + task.id);
  return {
    repo,
    store: opened.store,
    task,
    acceptanceCommandId: accepted.acceptanceCommandId,
    exe: nativeExe(),
  };
}

function command(
  id: string,
  acceptanceCommandId: string,
  workerProfileId = 'codex-luna',
) {
  return {
    command_id: id,
    acceptance_command_id: acceptanceCommandId,
    worker_profile_id: workerProfileId,
  };
}

function childRun(
  store: Store,
  repo: string,
  cmd: unknown,
  context: unknown,
  exe: string,
  stage?: string,
) {
  return spawnSync(
    process.execPath,
    [
      fixture,
      '--mode',
      'intent',
      '--store',
      store.path,
      '--repo',
      repo,
      '--command',
      JSON.stringify(cmd),
      '--context',
      JSON.stringify(context),
      '--exe',
      exe,
      ...(stage ? ['--stage', stage] : []),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

function childIntent(
  dbPath: string,
  repo: string,
  cmd: unknown,
  context: unknown,
  exe: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--mode',
        'intent',
        '--store',
        dbPath,
        '--repo',
        repo,
        '--command',
        JSON.stringify(cmd),
        '--context',
        JSON.stringify(context),
        '--exe',
        exe,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
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
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'intent child failed'));
        return;
      }
      const line = stdout
        .split(String.fromCharCode(10))
        .map((item) => item.trim())
        .find((item) => item.startsWith('{'));
      if (!line) {
        reject(new Error('missing child result'));
        return;
      }
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

describe('S3B2A durable accepted-PLAN dispatch intent', () => {
  it('atomically creates one launching dispatch + normalized receipt without task mutation or spawn', () => {
    const { repo, store, task, acceptanceCommandId, exe } =
      setupImplementation();
    const beforeTask = store.getTask(task.id);
    const beforeEvents = store.listEvents(task.id);

    const result = createAcceptedDispatchIntent(
      store,
      command('delegate-1', acceptanceCommandId),
      owner(repo),
      builtinWorkerProfiles(),
      launchOptions(exe),
    );

    expect(result.decision).toBe('CREATED');
    if (result.decision !== 'CREATED') return;
    expect(result.receipt).toMatchObject({
      command_id: 'delegate-1',
      acceptance_command_id: acceptanceCommandId,
      task_id: task.id,
      accepted_revision: task.revision,
      worker_profile_id: 'codex-luna',
      adapter_id: 'codex-exec-luna',
      dispatch_status: 'launching',
    });
    expect(result.receipt.launch_spec.launcher.executable_sha256).toBe(
      createHash('sha256').update('codex-native-v1').digest('hex'),
    );

    const dispatch = store.getDispatchRun(result.receipt.dispatch_run_id);
    expect(dispatch).toMatchObject({
      task_id: task.id,
      status: 'launching',
      pid: null,
      runner_instance_id: null,
      worker_profile_id: 'codex-luna',
      adapter_id: 'codex-exec-luna',
    });
    expect(store.getTask(task.id)).toEqual(beforeTask);
    expect(store.listEvents(task.id)).toEqual(beforeEvents);
  });

  it('requires OWNER/repository admission and a current READY IMPLEMENTATION revision', () => {
    const { repo, store, task, acceptanceCommandId, exe } =
      setupImplementation();
    const cmd = command('delegate-admission', acceptanceCommandId);

    expect(
      createAcceptedDispatchIntent(
        store,
        cmd,
        { actor_role: 'JUNIOR', repo_root: repo },
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'ROLE_FORBIDDEN' });

    expect(
      createAcceptedDispatchIntent(
        store,
        cmd,
        { actor_role: 'OWNER', repo_root: repo + '-other' },
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'REPOSITORY_MISMATCH' });

    const running = claimTask(
      store,
      snapshot(repo),
      'JUNIOR',
      'stale-runner',
      task.id,
      task.revision,
    );
    const blocked = reportBlocked(store, 'JUNIOR', 'stale-runner', {
      task_id: running.id,
      revision: running.revision,
      blocker: {
        reason: 'OTHER',
        summary: 'advance revision',
        need_from_owner: 'resume',
        evidence_refs: [],
      },
    });
    const resumed = resumeTask(store, snapshot(repo), {
      task_id: blocked.id,
      revision: blocked.revision,
    });
    expect(resumed.status).toBe('READY');

    expect(
      createAcceptedDispatchIntent(
        store,
        cmd,
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'REVISION_MISMATCH' });
  });

  it('rejects DIAGNOSIS, missing acceptance, and unfinished checkpoint', () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    const exe = nativeExe();

    expect(
      createAcceptedDispatchIntent(
        opened.store,
        command('missing', 'no-acceptance'),
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'ACCEPTANCE_NOT_FOUND' });

    const diagnosis = createTask(opened.store, snapshot(repo), {
      type: 'DIAGNOSIS',
      payload: diagnosisPayload,
    });
    const diagnosisAcceptance = acceptPlan(
      opened.store,
      repo,
      diagnosis,
      'diagnosis-plan',
    );
    expect(
      createAcceptedDispatchIntent(
        opened.store,
        command('diagnosis-delegate', diagnosisAcceptance.acceptanceCommandId),
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'WRONG_TASK_TYPE' });

    const impl = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const implAcceptance = acceptPlan(
      opened.store,
      repo,
      impl,
      'checkpoint-plan',
    );
    opened.store.transact(() =>
      opened.store.insertCheckpointIntent({
        id: 'pending-checkpoint',
        task_id: impl.id,
        producer_revision: impl.revision,
        purpose: 'RESUME',
        state: 'PREPARED',
        request_identity: 'pending-checkpoint-request',
        repo_root: repo,
        prior_base_commit: impl.base_commit,
        expected_tree: impl.base_commit,
        scope_identity: 'scope',
        checkpoint_commit: null,
        checkpoint_ref: 'refs/engineering-mcp/checkpoints/pending',
        branch: impl.branch,
        changed_files: [],
        created_at: new Date().toISOString(),
        finalized_at: null,
      }),
    );

    expect(
      createAcceptedDispatchIntent(
        opened.store,
        command('checkpoint-delegate', implAcceptance.acceptanceCommandId),
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'CHECKPOINT_FINALIZATION_REQUIRED',
    });
  });

  it('consumes each acceptance once and detects command identity conflicts', () => {
    const { repo, store, acceptanceCommandId, exe } = setupImplementation();
    const original = command('same-command', acceptanceCommandId);
    expect(
      createAcceptedDispatchIntent(
        store,
        original,
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ).decision,
    ).toBe('CREATED');

    expect(
      createAcceptedDispatchIntent(
        store,
        command('second-command', acceptanceCommandId),
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'ACCEPTANCE_ALREADY_CONSUMED',
    });

    expect(
      createAcceptedDispatchIntent(
        store,
        command('same-command', acceptanceCommandId, 'other-profile'),
        owner(repo),
        builtinWorkerProfiles(),
        {
          launchSpecBuildOptions: {
            platform: 'win32',
            env: {},
            resolveLauncher: () => {
              throw new Error('replay must not rediscover launcher');
            },
          },
        },
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'COMMAND_ID_CONFLICT',
    });
  });

  it('exact replay returns original launch spec without re-resolving mutable profile/launcher state', () => {
    const { repo, store, task, acceptanceCommandId, exe } =
      setupImplementation();
    const cmd = command('replay-command', acceptanceCommandId);
    const created = createAcceptedDispatchIntent(
      store,
      cmd,
      owner(repo),
      builtinWorkerProfiles(),
      launchOptions(exe),
    );
    expect(created.decision).toBe('CREATED');
    if (created.decision !== 'CREATED') return;

    const original = created.receipt;
    writeFileSync(exe, 'mutated-executable-after-commit', 'utf8');
    const mutatedRegistry: WorkerProfiles = {
      defaultProfile: 'changed',
      sourcePath: 'C:\\changed\\profiles.yaml',
      profiles: new Map(),
    };

    expect(
      createAcceptedDispatchIntent(
        store,
        cmd,
        owner(repo),
        mutatedRegistry,
        {
          launchSpecBuildOptions: {
            platform: 'win32',
            env: {
              PATH: 'C:\\changed',
              ENGINEERING_MCP_CODEX_LAUNCHER: 'C:\\changed\\codex.exe',
            },
            resolveLauncher: () => {
              throw new Error('must never resolve launcher during replay');
            },
          },
        },
      ),
    ).toEqual({
      decision: 'NOOP_WITH_EXISTING_DELEGATION',
      receipt: original,
    });

    expect(
      createAcceptedDispatchIntent(
        store,
        cmd,
        { actor_role: 'OWNER', repo_root: repo + '-other' },
        mutatedRegistry,
        {},
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REPOSITORY_MISMATCH',
    });

    expect(store.getTask(task.id)?.status).toBe('READY');
  });

  it('rolls back dispatch and receipt together across real process death boundaries', () => {
    for (const [stage, code, durable] of [
      ['after_validation', 101, false],
      ['after_dispatch_insert', 102, false],
      ['after_receipt_insert', 103, false],
      ['after_commit', 104, true],
    ] as const) {
      const { repo, store, acceptanceCommandId, exe } = setupImplementation();
      const cmd = command('crash-' + stage, acceptanceCommandId);
      const child = childRun(store, repo, cmd, owner(repo), exe, stage);
      expect(child.status, child.stderr).toBe(code);

      const receipt = store.getC2CDelegationIntentReceipt(cmd.command_id);
      const dispatches = receipt
        ? store.listDispatchRunsForTask(receipt.task_id)
        : [];
      expect(Boolean(receipt)).toBe(durable);
      expect(dispatches.length).toBe(durable ? 1 : 0);
    }
  });

  it('serializes concurrent identical commands into one dispatch and replay', async () => {
    const { repo, store, acceptanceCommandId, exe } = setupImplementation();
    const cmd = command('concurrent-same', acceptanceCommandId);

    const results = await Promise.all([
      childIntent(store.path, repo, cmd, owner(repo), exe),
      childIntent(store.path, repo, cmd, owner(repo), exe),
      childIntent(store.path, repo, cmd, owner(repo), exe),
    ]);

    expect(results.filter((item) => item.decision === 'CREATED')).toHaveLength(1);
    expect(
      results.filter(
        (item) => item.decision === 'NOOP_WITH_EXISTING_DELEGATION',
      ),
    ).toHaveLength(2);

    const receipt = store.getC2CDelegationIntentReceipt(cmd.command_id);
    expect(receipt).toBeDefined();
    expect(store.listDispatchRunsForTask(receipt!.task_id)).toHaveLength(1);
  });

  it('serializes different commands consuming the same acceptance', async () => {
    const { repo, store, acceptanceCommandId, exe } = setupImplementation();

    const results = await Promise.all([
      childIntent(
        store.path,
        repo,
        command('consume-a', acceptanceCommandId),
        owner(repo),
        exe,
      ),
      childIntent(
        store.path,
        repo,
        command('consume-b', acceptanceCommandId),
        owner(repo),
        exe,
      ),
    ]);

    expect(results.filter((item) => item.decision === 'CREATED')).toHaveLength(1);
    const rejected = results.find((item) => item.decision === 'REJECT') as
      | { code?: unknown }
      | undefined;
    expect(rejected?.code).toBe('ACCEPTANCE_ALREADY_CONSUMED');
  });

  it('shares the authoritative active-dispatch invariant when ordinary delegation wins', async () => {
    const { repo, store, task, acceptanceCommandId, exe } =
      setupImplementation();

    const ordinary = await delegateTask(
      store,
      snapshot(repo),
      task.id,
      task.revision,
      {
        adapterId: 'fixture',
        wait: false,
        runnerEntry: fixture,
        runnerArgs: ['--mode', 'delayed-runner', '--delay', '1500'],
      },
    );
    expect(ordinary.status).toBe('launching');
    expect(store.getTask(task.id)?.status).toBe('READY');

    expect(
      createAcceptedDispatchIntent(
        store,
        command('c2c-after-ordinary', acceptanceCommandId),
        owner(repo),
        builtinWorkerProfiles(),
        launchOptions(exe),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'ACTIVE_DISPATCH_EXISTS',
    });
    expect(store.listDispatchRunsForTask(task.id)).toHaveLength(1);

    // The ordinary runner intentionally stays alive long enough for the C2C
    // check. Let it exit before afterEach removes its working directory.
    const terminal = await waitForDispatch(store, ordinary.id, 5_000);
    expect(terminal.status).toBe('failed');
  });

  it('database active-dispatch uniqueness fences an ordinary delegate whose precheck is stale after C2C wins', async () => {
    const { repo, store, task, acceptanceCommandId, exe } =
      setupImplementation();
    const created = createAcceptedDispatchIntent(
      store,
      command('c2c-wins', acceptanceCommandId),
      owner(repo),
      builtinWorkerProfiles(),
      launchOptions(exe),
    );
    expect(created.decision).toBe('CREATED');

    const ordinary = Store.open(store.path, { repoRoot: repo });
    stores.push(ordinary);
    const originalGetActive = ordinary.getActiveDispatchForTask.bind(ordinary);
    (
      ordinary as unknown as {
        getActiveDispatchForTask: (taskId: string) => undefined;
      }
    ).getActiveDispatchForTask = () => undefined;

    await expect(
      delegateTask(ordinary, snapshot(repo), task.id, task.revision, {
        adapterId: 'fixture',
        wait: false,
        runnerEntry: fixture,
        runnerArgs: ['--mode', 'delayed-runner', '--delay', '1000'],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed|constraint/i);

    (
      ordinary as unknown as {
        getActiveDispatchForTask: typeof originalGetActive;
      }
    ).getActiveDispatchForTask = originalGetActive;

    expect(store.listDispatchRunsForTask(task.id)).toHaveLength(1);
    expect(store.getActiveDispatchForTask(task.id)?.id).toBe(
      created.decision === 'CREATED'
        ? created.receipt.dispatch_run_id
        : undefined,
    );
  });
});
