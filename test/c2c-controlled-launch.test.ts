import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { claimNextTask, claimTask, createTask } from '../src/lifecycle.ts';
import { launchControlledC2CWorker } from '../src/orchestration/c2c-launch-controller.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import type { Store } from '../src/store.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  tempDir,
} from './helpers.ts';

const workerFixture = fileURLToPath(
  new URL('./fixtures/c2c-controlled-worker.ts', import.meta.url),
);

const dirs: string[] = [];
const stores: Store[] = [];
const priorDelay = process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS;
const priorSentinel = process.env.ENGINEERING_MCP_TEST_C2C_SENTINEL;

afterEach(() => {
  if (priorDelay === undefined) delete process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS;
  else process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS = priorDelay;
  if (priorSentinel === undefined) delete process.env.ENGINEERING_MCP_TEST_C2C_SENTINEL;
  else process.env.ENGINEERING_MCP_TEST_C2C_SENTINEL = priorSentinel;
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for C2C controlled launch state');
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function nativeExe(): string {
  const dir = tempDir('eng-mcp-c2c-b2b-native-');
  dirs.push(dir);
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, 'native-codex-artifact', 'utf8');
  return exe;
}

function setupIntent() {
  const repo = initGitRepo();
  const opened = openTempStore(repo);
  dirs.push(repo, opened.dir);
  stores.push(opened.store);
  const store = opened.store;

  const task = createTask(store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload: implPayload,
  });
  const message = {
    protocol_version: 'engineering-c2c/1' as const,
    message_id: 'b2b-plan-' + task.id,
    task_id: task.id,
    sender_role: 'OWNER' as const,
    state: 'PLAN' as const,
    expected_revision: task.revision,
    goal: 'controlled launch',
  };
  expect(
    durableEvaluateC2CMessage(
      store,
      message,
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('REQUIRES_OWNER_ACTION');

  const acceptance = 'b2b-accept-' + task.id;
  expect(
    acceptEvaluatedPlan(
      store,
      { command_id: acceptance, plan_message: message },
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('ACCEPTED');

  const exe = nativeExe();
  const delegated = createAcceptedDispatchIntent(
    store,
    {
      command_id: 'b2b-delegate-' + task.id,
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
  expect(delegated.decision).toBe('CREATED');
  if (delegated.decision !== 'CREATED') {
    throw new Error('failed to create C2C dispatch intent');
  }
  return {
    repo,
    store,
    task,
    dispatchId: delegated.receipt.dispatch_run_id,
  };
}

describe('S3B2B controlled Worker spawn and claim authority', () => {
  it('duplicate Workers produce exactly one authoritative claim and one fake-Codex execution sentinel', async () => {
    const { repo, store, dispatchId } = setupIntent();
    const sentinelDir = tempDir('eng-mcp-c2c-b2b-sentinel-');
    dirs.push(sentinelDir);
    const sentinel = join(sentinelDir, 'executions.txt');
    process.env.ENGINEERING_MCP_TEST_C2C_SENTINEL = sentinel;
    process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS = '100';
    const observations: string[] = [];

    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: workerFixture,
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: workerFixture,
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });

    await waitUntil(() => store.getTask(store.getDispatchRun(dispatchId)!.task_id)?.status === 'RUNNING');
    await waitUntil(() => existsSync(sentinel));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const lines = readFileSync(sentinel, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines).toHaveLength(1);

    const dispatch = store.getDispatchRun(dispatchId)!;
    const task = store.getTask(dispatch.task_id)!;
    expect(dispatch.status).toBe('running');
    expect(task.status).toBe('RUNNING');
    expect(dispatch.runner_instance_id).toBeTruthy();
    expect(dispatch.runner_instance_id).toBe(task.execution_instance_id);
    await waitUntil(() => observations.filter((kind) => kind === 'close').length === 2);
  });

  it('failed duplicate physical attempt callback is non-authoritative before another Worker claims', async () => {
    const { repo, store, dispatchId } = setupIntent();
    process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS = '700';
    const successfulObservations: string[] = [];

    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: workerFixture,
      onPhysicalObservation(observation) {
        successfulObservations.push(observation.kind);
      },
    });

    const observations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: join(repo, 'absent-c2c-worker-entry.ts'),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });

    await waitUntil(() => observations.includes('close'));
    const beforeClaim = store.getDispatchRun(dispatchId)!;
    expect(beforeClaim.status).toBe('launching');
    expect(beforeClaim.runner_instance_id).toBeNull();
    expect(store.getTask(beforeClaim.task_id)?.status).toBe('READY');

    await waitUntil(() => store.getDispatchRun(dispatchId)?.status === 'running');
    const afterClaim = store.getDispatchRun(dispatchId)!;
    expect(afterClaim.runner_instance_id).toBeTruthy();
    expect(store.getTask(afterClaim.task_id)?.execution_instance_id).toBe(
      afterClaim.runner_instance_id,
    );
    await waitUntil(() => successfulObservations.includes('close'));
  });

  it('a physical failure while still launching cannot prevent a later Worker claim', async () => {
    const { repo, store, dispatchId } = setupIntent();
    const observations: string[] = [];

    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: join(repo, 'absent-first-worker-entry.ts'),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    await waitUntil(() => observations.includes('close'));

    expect(store.getDispatchRun(dispatchId)).toMatchObject({
      status: 'launching',
      runner_instance_id: null,
    });

    process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS = '0';
    const successfulObservations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: workerFixture,
      onPhysicalObservation(observation) {
        successfulObservations.push(observation.kind);
      },
    });
    await waitUntil(() => store.getDispatchRun(dispatchId)?.status === 'running');
    await waitUntil(() => successfulObservations.includes('close'));

    expect(store.getTask(store.getDispatchRun(dispatchId)!.task_id)?.status).toBe(
      'RUNNING',
    );
  });

  it('ordinary claim_task cannot steal a C2C-reserved READY task and claim_next_task skips it', () => {
    const { repo, store, task } = setupIntent();
    const git = snapshot(repo);

    expect(() =>
      claimTask(
        store,
        git,
        'JUNIOR',
        'ordinary-steal-attempt',
        task.id,
        task.revision,
      ),
    ).toThrow(/reserved by active C2C dispatch/i);

    const ordinary = createTask(store, git, {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const claimed = claimNextTask(
      store,
      git,
      'JUNIOR',
      'ordinary-next-worker',
    );
    expect(claimed.id).toBe(ordinary.id);
    expect(store.getTask(task.id)?.status).toBe('READY');
  });

  it('a retry after authoritative claim returns existing state and does not spawn another Worker', async () => {
    const { repo, store, dispatchId } = setupIntent();
    process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS = '0';
    const observations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      runnerEntry: workerFixture,
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    await waitUntil(() => store.getDispatchRun(dispatchId)?.status === 'running');

    let spawned = false;
    const result = launchControlledC2CWorker(store, repo, dispatchId, {
      spawnWorker: (() => {
        spawned = true;
        throw new Error('must not spawn after claim');
      }) as never,
    });
    expect(result.state).toBe('ALREADY_CLAIMED');
    expect(spawned).toBe(false);
    await waitUntil(() => observations.includes('close'));
  });
});
