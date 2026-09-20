import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lifecycle from '../src/lifecycle.ts';
import * as registry from '../src/c2c/durable-target-registry.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { buildGenericCliTargetV1 } from '../src/commands/generic-cli-target-v1.ts';
import { renderEngineeringGenericCliEwpNativeV1 } from '../src/commands/generic-cli-ewp-native-v1.ts';
import { launchControlledC2CWorker } from '../src/orchestration/c2c-launch-controller.ts';
import { runC2CWorkerRunner } from '../src/orchestration/c2c-worker-runner.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import { dispatchRunDir } from '../src/dispatch-run-dir.ts';
import { executionOutput, executionSummary, testStatus } from '../src/evidence/projection.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION, WRITER_PROTOCOL_GENERATION, type ImplementationResult } from '../src/types.ts';
import { loadWorkerProfiles } from '../src/worker-profiles.ts';
import { implPayload, initGitRepo, openTempStore, snapshot, tempDir } from './helpers.ts';
import { executionCount, genericFixture, genericManifest, waitFor } from './fixtures/c2c-generic-support.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const children: ChildProcess[] = [];
const trackedSpawn = ((command: string, args: string[], options: SpawnOptions) => {
  const child = spawn(command, args, options);
  children.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}) as typeof spawn;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill();
      await new Promise<void>((resolve) => { child.once('close', () => resolve()); setTimeout(resolve, 300); });
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    expect(existsSync(dir)).toBe(false);
  }
});

type Fixture = ReturnType<typeof genericFixture>;
async function launch(f: Fixture, count = 1, runnerEntry?: string) {
  let closes = 0;
  for (let i = 0; i < count; i++) launchControlledC2CWorker(f.store, f.repo, f.receipt.dispatch_run_id, {
    runnerEntry, spawnWorker: trackedSpawn,
    onPhysicalObservation(event) { if (event.kind === 'close') closes++; },
  });
  await waitFor(() => closes === count);
  return f.store.getTask(f.task.id)!;
}

function savedTarget(store: Store, commandId: string): string {
  const raw = new DatabaseSync(store.path, { readOnly: true });
  try {
    return (raw.prepare('SELECT launch_spec_json FROM c2c_delegation_receipts WHERE command_id = ?').get(commandId) as { launch_spec_json: string }).launch_spec_json;
  } finally { raw.close(); }
}

describe.skipIf(process.platform !== 'win32')('Harness Bridge B real native GenericCli C2C path', () => {
  it('runs the real controlled Worker, exact native exe, frozen EWP, lifecycle and independent S2 evidence', async () => {
    const f = genericFixture(dirs, stores);
    const beforeJson = savedTarget(f.store, f.command.command_id);
    const terminal = await launch(f);
    expect(terminal.status).toBe('COMPLETED');
    expect(terminal.execution_instance_id).toBeNull();
    expect(executionCount(f.runDir)).toBe(1);
    expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe('native harness edit\n');
    const request = readFileSync(join(f.runDir, 'request.json'), 'utf8');
    expect(request).toBe(renderEngineeringGenericCliEwpNativeV1({ task: f.task, taskId: f.task.id, dispatchRunId: f.receipt.dispatch_run_id, repositoryRoot: f.repo, baseCommit: f.task.base_commit }));
    const result = terminal.result as ImplementationResult;
    expect(result.changed_files).toEqual(['README.md']);
    expect(result.evidence?.worker_reported?.changed_files).toEqual([]);
    expect(result.evidence?.worker_reported?.validation?.[0]).toMatchObject({ command: 'fake validation', status: 'passed' });
    expect(result.evidence?.runner_observed?.changed_files).toEqual(['README.md']);
    expect(result.evidence?.runner_observed?.git).toMatchObject({ head: f.before.head, branch: f.before.branch });
    expect(result.evidence?.runner_observed?.scope).toEqual({ status: 'passed', rejected_files: [] });
    expect(result.evidence?.server_authoritative).toMatchObject({ task_id: f.task.id, repo_root: f.repo, actor_role: 'JUNIOR' });
    const claims = f.store.listEvents(f.task.id).filter((event) => event.kind === 'claimed');
    expect(claims).toHaveLength(1);
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)?.runner_instance_id).toBe(claims[0]!.detail?.execution_instance_id);
    expect(savedTarget(f.store, f.command.command_id)).toBe(beforeJson);
    for (const secret of ['metadata-private-sentinel', 'capabilities-private-sentinel']) expect(beforeJson).not.toContain(secret);
    const evidenceSnapshot = {
      trusted_repo_root: f.repo, task: terminal, task_events: f.store.listEvents(f.task.id),
      dispatch: f.store.getDispatchRun(f.receipt.dispatch_run_id)!,
    };
    const selector = { task_id: f.task.id, dispatch_run_id: f.receipt.dispatch_run_id };
    expect(executionOutput(evidenceSnapshot, selector)).toMatchObject({ ok: true, value: {
      worker_reported: { verification: 'REPORTED' }, runner_observed: { verification: 'VERIFIED' },
      server_authoritative: { verification: 'VERIFIED' },
    } });
    expect(executionSummary(evidenceSnapshot, selector)).toMatchObject({ ok: true, value: {
      reported_summary: { verification: 'REPORTED' }, process: { verification: 'VERIFIED' },
    } });
    expect(testStatus(evidenceSnapshot, selector)).toMatchObject({ ok: true, value: {
      overall: { result: 'PASSED', verification: 'REPORTED' },
    } });
    const raw = new DatabaseSync(f.store.path, { readOnly: true });
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM c2c_delegation_receipts').get()).toEqual({ count: 1 });
    } finally { raw.close(); }
    expect(SCHEMA_VERSION).toBe(12);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
  });

  it('duplicate physical Workers cause exactly one authoritative claim and one real native execution', async () => {
    const f = genericFixture(dirs, stores);
    const terminal = await launch(f, 2);
    expect(terminal.status).toBe('COMPLETED');
    expect(f.store.listEvents(f.task.id).filter((event) => event.kind === 'claimed')).toHaveLength(1);
    expect(executionCount(f.runDir)).toBe(1);
    const state = f.store.getDispatchRun(f.receipt.dispatch_run_id);
    let spawned = false;
    const retry = launchControlledC2CWorker(f.store, f.repo, f.receipt.dispatch_run_id, { spawnWorker: (() => { spawned = true; throw new Error('no terminal respawn'); }) as never });
    expect(retry.state).toBe('TERMINAL');
    expect(spawned).toBe(false);
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)).toEqual(state);
  });

  it('a failed physical Worker callback has no logical authority and a later real Worker still claims', async () => {
    const f = genericFixture(dirs, stores);
    const taskBefore = f.store.getTask(f.task.id);
    const dispatchBefore = f.store.getDispatchRun(f.receipt.dispatch_run_id);
    await launch(f, 1, join(f.assets, 'missing-worker-entry.ts'));
    expect(f.store.getTask(f.task.id)).toEqual(taskBefore);
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)).toEqual(dispatchBefore);
    expect(executionCount(f.runDir)).toBe(0);
    expect((await launch(f)).status).toBe('COMPLETED');
    expect(executionCount(f.runDir)).toBe(1);
  });

  it('ordinary claims cannot steal the Generic C2C reservation and claim_next skips it', () => {
    const f = genericFixture(dirs, stores);
    expect(() => lifecycle.claimTask(f.store, f.before, 'JUNIOR', 'steal', f.task.id, f.task.revision)).toThrow(/reserved by active C2C dispatch/i);
    const ordinary = lifecycle.createTask(f.store, f.before, { type: 'IMPLEMENTATION', payload: implPayload });
    expect(lifecycle.claimNextTask(f.store, f.before, 'JUNIOR', 'ordinary').id).toBe(ordinary.id);
    expect(f.store.getTask(f.task.id)?.status).toBe('READY');
    expect(executionCount(f.runDir)).toBe(0);
  });

  it('reopens and exactly replays despite manifest/profile/PATH mutation, then executes the original artifact', async () => {
    const f = genericFixture(dirs, stores);
    const originalJson = savedTarget(f.store, f.command.command_id);
    const alternate = tempDir('eng-mcp-b-alternative-');
    dirs.push(alternate);
    writeFileSync(join(alternate, 'generic-native.exe'), 'must never execute');
    vi.stubEnv('PATH', alternate + ';' + (process.env.PATH ?? ''));
    writeFileSync(f.manifestPath, 'malformed changed manifest');
    writeFileSync(f.profilesPath, 'malformed changed profiles');
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    f.store = Store.open(f.store.path, { repoRoot: f.repo });
    stores.push(f.store);
    const build = vi.spyOn(registry, 'buildDurableTargetFromTrustedProfile');
    const rediscover = vi.fn(() => { throw new Error('must never rediscover'); });
    const replay = createAcceptedDispatchIntent(f.store, f.command, f.owner, {
      defaultProfile: 'changed', sourcePath: f.profilesPath, profiles: new Map(),
    }, { launchSpecBuildOptions: { resolveExecutable: rediscover, resolveLauncher: () => { throw new Error('must not resolve Codex'); } } });
    expect(replay).toEqual({ decision: 'NOOP_WITH_EXISTING_DELEGATION', receipt: f.receipt });
    expect(build).not.toHaveBeenCalled();
    expect(rediscover).not.toHaveBeenCalled();
    expect(createAcceptedDispatchIntent(f.store, { ...f.command, worker_profile_id: 'other' }, f.owner, f.profiles)).toMatchObject({ decision: 'REJECT', code: 'COMMAND_ID_CONFLICT' });
    expect((await launch(f)).status).toBe('COMPLETED');
    expect(savedTarget(f.store, f.command.command_id)).toBe(originalJson);
    expect(executionCount(f.runDir)).toBe(1);
  });

  it.each(['changed', 'missing'])('fails %s artifacts before claim without invoking another PATH executable', async (mode) => {
    const f = genericFixture(dirs, stores);
    if (mode === 'changed') writeFileSync(f.exe, 'different bytes');
    else rmSync(f.exe);
    const terminal = await launch(f);
    expect(terminal).toMatchObject({ status: 'READY', revision: f.task.revision, execution_instance_id: null });
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)).toMatchObject({ status: 'failed', runner_instance_id: null, error_code: 'WORKER_PROCESS_FAILED' });
    expect(f.store.listEvents(f.task.id).filter((event) => event.kind === 'claimed')).toHaveLength(0);
    expect(executionCount(f.runDir)).toBe(0);
  });

  it('postclaim artifact replacement becomes BLOCKED through the original Runner and never falls back', async () => {
    const f = genericFixture(dirs, stores);
    const originalClaim = lifecycle.claimC2CDispatchTask;
    vi.spyOn(lifecycle, 'claimC2CDispatchTask').mockImplementation((...args) => {
      const task = originalClaim(...args);
      writeFileSync(f.exe, 'replaced after authoritative claim');
      return task;
    });
    const terminal = await runC2CWorkerRunner({ store: f.store, git: f.before, dispatchRunId: f.receipt.dispatch_run_id, executionInstanceId: 'postclaim-replacement' });
    expect(terminal.status).toBe('BLOCKED');
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)).toMatchObject({ status: 'blocked', error_code: 'WORKER_PROCESS_FAILED', runner_instance_id: 'postclaim-replacement' });
    expect(executionCount(f.runDir)).toBe(0);
    expect(f.store.listEvents(f.task.id).filter((event) => event.kind === 'claimed')).toHaveLength(1);
  });

  it.each([
    ['malformed', 'WORKER_PROTOCOL_FAILURE'], ['echo', 'WORKER_PROTOCOL_FAILURE'],
    ['process-failure', 'WORKER_PROCESS_FAILED'], ['forbidden', 'SCOPE_VIOLATION'],
    ['ignored', 'SCOPE_VIOLATION'], ['head', 'UNEXPECTED_HEAD_CHANGE'],
  ])('preserves Runner failure semantics for native mode %s', async (mode, code) => {
    const f = genericFixture(dirs, stores, mode);
    const terminal = await launch(f);
    expect(terminal.status).toBe('BLOCKED');
    expect(f.store.getDispatchRun(f.receipt.dispatch_run_id)).toMatchObject({ status: 'blocked', error_code: code });
    expect(executionCount(f.runDir)).toBe(1);
    if (mode === 'forbidden' || mode === 'ignored') {
      const file = mode === 'forbidden' ? 'AGENTS.md' : '.cache/secret.txt';
      expect(terminal.blocker?.evidence?.worker_reported?.changed_files).toEqual([]);
      expect(terminal.blocker?.evidence?.runner_observed?.scope).toEqual({ status: 'failed', rejected_files: [file] });
    }
    if (mode === 'head') expect(terminal.blocker?.evidence?.runner_observed?.git.head).not.toBe(f.before.head);
    else expect(snapshot(f.repo).head).toBe(f.before.head);
  });

  it('accepts only durably authorized process success codes and keeps a valid reported BLOCKED result', async () => {
    const nonzero = genericFixture(dirs, stores, 'success7', [7]);
    expect((await launch(nonzero)).status).toBe('COMPLETED');
    expect(nonzero.store.getDispatchRun(nonzero.receipt.dispatch_run_id)?.exit_code).toBe(7);
    const blocked = genericFixture(dirs, stores, 'blocked');
    expect((await launch(blocked)).status).toBe('BLOCKED');
    expect(blocked.store.getDispatchRun(blocked.receipt.dispatch_run_id)?.error_code).toBeNull();
  });

  it('ordinary GenericCli still executes an interpreter+literal-argv manifest with no PLAN, acceptance or C2C receipt', async () => {
    const repo = initGitRepo();
    const assets = tempDir('eng-mcp-ordinary-b-');
    const opened = openTempStore(repo);
    dirs.push(repo, assets, opened.dir); stores.push(opened.store);
    const harness = fileURLToPath(new URL('./fixtures/generic-harness.cjs', import.meta.url));
    const m = { ...genericManifest(process.execPath), arguments: [harness, '--mode', 'completed'] };
    const manifestPath = join(assets, 'ordinary.json');
    const profilesPath = join(assets, 'profiles.json');
    writeFileSync(manifestPath, JSON.stringify(m));
    writeFileSync(profilesPath, JSON.stringify({ schema: 'engineering-worker-profiles/1', default_profile: 'ordinary', profiles: { ordinary: { adapter: 'generic-cli', manifest: manifestPath } } }));
    const profiles = loadWorkerProfiles(profilesPath);
    expect(buildGenericCliTargetV1(profiles, 'ordinary')).toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
    const before = snapshot(repo);
    const task = lifecycle.createTask(opened.store, before, { type: 'IMPLEMENTATION', payload: { ...implPayload, goal: 'Create hello.txt', allowed_scope: ['hello.txt'], forbidden_scope: [] } });
    const run = await delegateTask(opened.store, before, task.id, task.revision, { adapterId: 'generic-cli', manifestPath, timeoutMs: 15_000 });
    dirs.push(dispatchRunDir(run.id));
    expect(run.status).toBe('completed');
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('hello from generic harness\n');
    const raw = new DatabaseSync(opened.store.path, { readOnly: true });
    try { expect(raw.prepare('SELECT COUNT(*) AS count FROM c2c_delegation_receipts').get()).toEqual({ count: 0 }); }
    finally { raw.close(); }
  });
});
