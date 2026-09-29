import { configureUnitBootstrap, configureUnitProductionCredential,
  resetUnitBootstrap, settleUnitBootstraps,
  syntheticIdentityFrame, unitBootstrap } from './fixtures/c2c-native-unit-seam.ts';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { claimC2CDispatchTask, claimNextTask, claimTask, createTask } from '../src/lifecycle.ts';
import { launchControlledC2CWorker } from '../src/orchestration/c2c-launch-controller.ts';
import { executionWitnessPath } from '../src/orchestration/execution-group.ts';
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

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  try { await settleUnitBootstraps(); }
  finally {
    resetUnitBootstrap();
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) removeDir(dir);
  }
});

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

// These are native-boundary units, not cross-SID/Job acceptance or public E2E.
describe('controlled bootstrap unit: reservation and claim authority', () => {
  it('refuses a missing development frame without witness or launch request', () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    const before = store.getTask(store.getDispatchRun(dispatchId)!.task_id)!;
    const events = store.listEvents(before.id).length;
    const result = launchControlledC2CWorker(store, repo, dispatchId);
    expect(result.state).toBe('REFUSED');
    expect(unitBootstrap.attempts).toBe(0);
    expect(store.getRepositoryLaunchState(dispatchId)).not.toBe('REQUESTED');
    expect(store.getDispatchRun(dispatchId)?.status).toBe('launching');
    expect(store.getTask(before.id)).toMatchObject({ status: 'READY', revision: before.revision });
    expect(store.listEvents(before.id)).toHaveLength(events);
    expect(() => readFileSync(executionWitnessPath(store.path, dispatchId))).toThrow();
  });

  it('refuses a development frame in protected mode and clears it before any reservation', () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    configureUnitProductionCredential();
    const supplied = syntheticIdentityFrame();
    const result = launchControlledC2CWorker(store, repo, dispatchId,
      { developmentIdentityFrame: supplied });
    expect(result.state).toBe('REFUSED');
    expect(supplied.every((byte) => byte === 0)).toBe(true);
    expect(unitBootstrap.attempts).toBe(0);
    expect(store.getRepositoryLaunchState(dispatchId)).not.toBe('REQUESTED');
    expect(() => readFileSync(executionWitnessPath(store.path, dispatchId))).toThrow();
  });

  it.each(['missing credential blob', 'credential ACL invalid', 'credential helper hash mismatch'])(
    'refuses protected preflight %s before credential acquisition or launch mutation', (cause) => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    configureUnitProductionCredential();
    const before = store.getTask(store.getDispatchRun(dispatchId)!.task_id)!;
    const events = store.listEvents(before.id).length;
    unitBootstrap.preflightError = new Error(cause);
    const result = launchControlledC2CWorker(store, repo, dispatchId);
    expect(result.state).toBe('REFUSED');
    expect(unitBootstrap.attempts).toBe(0);
    expect(store.getRepositoryLaunchState(dispatchId)).not.toBe('REQUESTED');
    expect(store.getDispatchRun(dispatchId)?.status).toBe('launching');
    expect(store.getTask(before.id)).toMatchObject({ status: 'READY', revision: before.revision });
    expect(store.listEvents(before.id)).toHaveLength(events);
    expect(() => readFileSync(executionWitnessPath(store.path, dispatchId))).toThrow();
    });

  it('refuses malformed protected helper plaintext before reservation and zeroes it', () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    const invalid = syntheticIdentityFrame();
    invalid.writeUInt32LE(257, 0);
    configureUnitProductionCredential(invalid);
    const before = store.getTask(store.getDispatchRun(dispatchId)!.task_id)!;
    const events = store.listEvents(before.id).length;
    const result = launchControlledC2CWorker(store, repo, dispatchId);
    expect(result.state).toBe('REFUSED');
    expect(invalid.every((byte) => byte === 0)).toBe(true);
    expect(unitBootstrap.attempts).toBe(0);
    expect(store.getRepositoryLaunchState(dispatchId)).not.toBe('REQUESTED');
    expect(store.getDispatchRun(dispatchId)?.status).toBe('launching');
    expect(store.getTask(before.id)).toMatchObject({ status: 'READY', revision: before.revision });
    expect(store.listEvents(before.id)).toHaveLength(events);
    expect(() => readFileSync(executionWitnessPath(store.path, dispatchId))).toThrow();
  });

  it.each(['DPAPI unseal failure', 'tampered credential blob'])(
    'refuses protected %s without durable launch mutation', (cause) => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    configureUnitProductionCredential(undefined, new Error(cause));
    const before = store.getTask(store.getDispatchRun(dispatchId)!.task_id)!;
    const events = store.listEvents(before.id).length;
    const observations: string[] = [];
    const result = launchControlledC2CWorker(store, repo, dispatchId,
      { onPhysicalObservation: (value) => observations.push(value.kind === 'error' ? value.message : value.kind) });
    expect(result.state).toBe('REFUSED');
    expect(observations).toEqual(['production credential acquisition refused launch']);
    expect(unitBootstrap.attempts).toBe(0);
    expect(store.getRepositoryLaunchState(dispatchId)).not.toBe('REQUESTED');
    expect(store.getDispatchRun(dispatchId)?.status).toBe('launching');
    expect(store.getTask(before.id)).toMatchObject({ status: 'READY', revision: before.revision });
    expect(store.listEvents(before.id)).toHaveLength(events);
    expect(() => readFileSync(executionWitnessPath(store.path, dispatchId))).toThrow();
    });

  it('passes a fresh protected frame to the existing bootstrap seam then zeroes its source', async () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    const frame = syntheticIdentityFrame(); const expected = Buffer.from(frame);
    configureUnitProductionCredential(frame);
    const result = launchControlledC2CWorker(store, repo, dispatchId);
    await settleUnitBootstraps();
    expect(result.state).toBe('SPAWNED');
    expect(unitBootstrap.attempts).toBe(1);
    expect(unitBootstrap.transfers).toHaveLength(1);
    expect(unitBootstrap.transfers[0]!.equals(expected)).toBe(true);
    expect(frame.every((byte) => byte === 0)).toBe(true);
    expected.fill(0);
  });
  it('duplicate launch requests and duplicate claims produce one claim and one unit execution sentinel', async () => {
    const { repo, store, dispatchId } = setupIntent();
    const sentinelDir = tempDir('eng-mcp-c2c-b2b-sentinel-');
    dirs.push(sentinelDir);
    const sentinel = join(sentinelDir, 'executions.txt');
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, automatic: false,
      onRunner({ instanceId }) {
        claimC2CDispatchTask(store, snapshot(repo), instanceId, dispatchId);
        appendFileSync(sentinel, `unit execution ${instanceId}\n`);
        expect(() => claimC2CDispatchTask(store, snapshot(repo), 'duplicate-unit-runner', dispatchId)).toThrow();
      },
    });

    const observations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });

    expect(unitBootstrap.attempts).toBe(1);
    await settleUnitBootstraps();
    expect(observations.filter((kind) => kind === 'close')).toHaveLength(1);

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
    expect(store.listEvents(task.id).filter((event) => event.kind === 'claimed')).toHaveLength(1);
  });

  it('a physical error callback and duplicate request are non-authoritative before the original Runner claims', async () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, automatic: false,
      onRunner({ instanceId }) { claimC2CDispatchTask(store, snapshot(repo), instanceId, dispatchId); },
    });

    const successfulObservations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        successfulObservations.push(observation.kind);
      },
    });

    const observations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });

    unitBootstrap.launches[0]!.child.emit('error', new Error('synthetic physical failure'));
    expect(successfulObservations).toContain('error');
    expect(observations).toEqual([]);
    expect(unitBootstrap.attempts).toBe(1);
    const beforeClaim = store.getDispatchRun(dispatchId)!;
    expect(beforeClaim.status).toBe('launching');
    expect(beforeClaim.runner_instance_id).toBeNull();
    expect(store.getTask(beforeClaim.task_id)?.status).toBe('READY');

    await settleUnitBootstraps();
    const afterClaim = store.getDispatchRun(dispatchId)!;
    expect(afterClaim.runner_instance_id).toBeTruthy();
    expect(store.getTask(afterClaim.task_id)?.execution_instance_id).toBe(
      afterClaim.runner_instance_id,
    );
    expect(successfulObservations).toContain('close');
  });

  it('an ambiguous physical failure retains occupancy, forbids another root, and does not revoke the original claim', () => {
    const { repo, store, dispatchId } = setupIntent();
    const observations: string[] = [];
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo, onRunner() {} });
    unitBootstrap.spawnError = new Error('synthetic bootstrap spawn failure');

    const failed = launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    expect(failed.state).toBe('REFUSED');
    expect(observations).toContain('error');

    expect(store.getDispatchRun(dispatchId)).toMatchObject({
      status: 'launching',
      runner_instance_id: null,
    });

    unitBootstrap.spawnError = undefined;
    const retry = launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
    });
    expect(retry.pid).toBeNull();
    expect(unitBootstrap.attempts).toBe(1);
    expect(store.getRepositoryLaunchState(dispatchId)).toBe('REQUESTED');
    const bootstrap = JSON.parse(readFileSync(executionWitnessPath(store.path, dispatchId), 'utf8')) as { runner_instance_id: string };
    // Unit lifecycle proof only: an error callback cannot revoke an already
    // authorized Runner. It does not authorize starting a replacement process.
    claimC2CDispatchTask(store, snapshot(repo), bootstrap.runner_instance_id, dispatchId);

    expect(store.getTask(store.getDispatchRun(dispatchId)!.task_id)?.status).toBe(
      'RUNNING',
    );
  });

  it('ordinary claims cannot steal a C2C task or bypass the same-repository active reservation', () => {
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
    expect(() => claimNextTask(
      store,
      git,
      'JUNIOR',
      'ordinary-next-worker',
    )).toThrow(/repository.*writers|active dispatch reservation/i);
    expect(store.getTask(ordinary.id)?.status).toBe('READY');
    expect(store.getTask(task.id)?.status).toBe('READY');
  });

  it('a retry after authoritative claim returns existing state and does not spawn another Worker', async () => {
    const { repo, store, dispatchId } = setupIntent();
    configureUnitBootstrap({ storePath: store.path, repoRoot: repo,
      onRunner({ instanceId }) { claimC2CDispatchTask(store, snapshot(repo), instanceId, dispatchId); },
    });
    const observations: string[] = [];
    launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
      onPhysicalObservation(observation) {
        observations.push(observation.kind);
      },
    });
    await settleUnitBootstraps();

    const attempts = unitBootstrap.attempts;
    unitBootstrap.spawnError = new Error('must not spawn after claim');
    const result = launchControlledC2CWorker(store, repo, dispatchId, {
      developmentIdentityFrame: syntheticIdentityFrame(),
    });
    expect(result.state).toBe('ALREADY_CLAIMED');
    expect(unitBootstrap.attempts).toBe(attempts);
    expect(observations).toContain('close');
  });
});
