import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as evaluationApi from '../src/receipts/c2c-evaluation.ts';
import * as acceptanceApi from '../src/commands/plan-acceptance.ts';
import * as delegationApi from '../src/commands/delegation-intent.ts';
import * as launchApi from '../src/orchestration/c2c-launch-controller.ts';
import * as codexBuilder from '../src/commands/launch-spec.ts';
import { executeC2CPlan, executeC2CPlanInputSchema, executeC2CPlanOutputSchema } from '../src/c2c/controller.ts';
import { C2C_PRIVATE_OPERATION, C2C_PROTOCOL_VERSION } from '../src/c2c/schema.ts';
import { runC2CWorkerRunner } from '../src/orchestration/c2c-worker-runner.ts';
import { createEngineeringServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { claimTask, cancelTask, closeTask, reportBlocked, reportResult, createTask } from '../src/lifecycle.ts';
import { OWNER_TOOLS, WORKER_TOOLS } from '../src/role.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import { SCHEMA_VERSION, WRITER_PROTOCOL_GENERATION, type ProcessRole } from '../src/types.ts';
import { dispatchRunDir } from '../src/dispatch-run-dir.ts';
import { executionOutput, testStatus } from '../src/evidence/projection.ts';
import { snapshot, implResult, diagnosisPayload, projectRoot } from './helpers.ts';
import { controllerFixture, controllerConnection } from './fixtures/c2c-controller-support.ts';
import { executionCount, waitFor } from './fixtures/c2c-generic-support.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const fixtures: ReturnType<typeof controllerFixture>[] = [];
const connections: Awaited<ReturnType<typeof controllerConnection>>[] = [];
const children: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
const realLaunch = launchApi.launchControlledC2CWorker;
const realEvaluate = evaluationApi.durableEvaluateC2CMessage;
const realAccept = acceptanceApi.acceptEvaluatedPlan;
const realDelegate = delegationApi.createAcceptedDispatchIntent;

function fixture() {
  const f = controllerFixture(dirs, stores);
  fixtures.push(f);
  return f;
}
const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  child.stdout?.resume();
  child.stderr?.resume();
  child.stdin?.end();
  children.push({ child, closed: new Promise<void>((resolve) => child.once('close', () => resolve())) });
  return child;
}) as typeof spawn;
function trackedLaunch(...args: Parameters<typeof realLaunch>) {
  return realLaunch(args[0], args[1], args[2], { ...args[3], spawnWorker: trackedSpawn });
}
function trackLaunch() { return vi.spyOn(launchApi, 'launchControlledC2CWorker').mockImplementation(trackedLaunch); }
function noPhysicalLaunch() {
  return vi.spyOn(launchApi, 'launchControlledC2CWorker').mockImplementation((store, repo, id, options) =>
    realLaunch(store, repo, id, { ...options, spawnWorker: (() => { throw new Error('PRIVATE_LAUNCH_TEXT'); }) as typeof spawn }));
}
function counts(f: ReturnType<typeof fixture>) {
  const db = new DatabaseSync(f.store.path, { readOnly: true });
  try {
    return ['c2c_evaluation_receipts', 'c2c_plan_acceptance_receipts', 'c2c_delegation_receipts'].map((table) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally { db.close(); }
}
function storedTarget(f: ReturnType<typeof fixture>) {
  const db = new DatabaseSync(f.store.path, { readOnly: true });
  try { return db.prepare('SELECT launch_spec_json FROM c2c_delegation_receipts WHERE command_id = ?').get(f.request.delegation_command_id); }
  finally { db.close(); }
}
async function completed(f: ReturnType<typeof fixture>) {
  await waitFor(() => f.store.getTask(f.task.id)?.status === 'COMPLETED');
  expect(f.store.listEvents(f.task.id).filter((event) => event.kind === 'claimed')).toHaveLength(1);
  const receipt = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)!;
  expect(executionCount(dispatchRunDir(receipt.dispatch_run_id))).toBe(1);
  return receipt;
}

afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    // Wait for process handles, not just terminal ledger state, before deleting fixtures.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill(); resolve(); }, 5000); })]);
      await closed;
    } finally { if (timer) clearTimeout(timer); }
  }
  for (const c of connections.splice(0)) await c.close();
  for (const f of fixtures.splice(0)) {
    for (const run of f.store.listDispatchRunsForTask(f.task.id)) dirs.push(dispatchRunDir(run.id));
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of new Set(dirs.splice(0))) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  vi.restoreAllMocks();
});

describe('production C2C controller registration and wire authority', () => {
  it.each([
    ['owner', undefined, OWNER_TOOLS], ['owner', false, OWNER_TOOLS],
    ['owner', true, [...OWNER_TOOLS, 'execute_c2c_plan']],
    ['junior', undefined, WORKER_TOOLS], ['principal', undefined, WORKER_TOOLS],
  ] as const)('registers exact surface for %s opt-in=%s', async (role, enabled, names) => {
    const f = fixture();
    const c = await controllerConnection({ ...f.context, processRole: role, enableC2CController: enabled });
    connections.push(c);
    expect((await c.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    if (!enabled) {
      await expect(c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request })).rejects.toThrow('Tool execute_c2c_plan not found');
      expect(counts(f)).toEqual([0, 0, 0]);
    }
  });

  it('registers only the private operation for the versioned companion client', async () => {
    const f = fixture();
    const c = await controllerConnection({
      ...f.context,
      c2cPrivateClient: true,
      c2cContractVersion: C2C_PROTOCOL_VERSION,
    });
    connections.push(c);
    expect((await c.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      C2C_PRIVATE_OPERATION,
    ]);
    await expect(
      c.client.callTool({ name: 'create_task', arguments: {} }),
    ).rejects.toThrow('Tool create_task not found');
  });

  it('fails closed when private-client mode is missing or mismatches the contract version', () => {
    const f = fixture();
    for (const c2cContractVersion of [undefined, 'engineering-c2c/999']) {
      expect(() => createEngineeringServer({
        ...f.context,
        executionInstanceId: 'test',
        c2cPrivateClient: true,
        c2cContractVersion,
      })).toThrow(/contract must be engineering-c2c\/1/);
    }
    expect(counts(f)).toEqual([0, 0, 0]);
  });

  it.each(['junior', 'principal'] as const)('rejects %s opt-in before registering any tools', (processRole) => {
    const f = fixture();
    expect(() => createEngineeringServer({ ...f.context, processRole, executionInstanceId: 'test' })).toThrow(/requires --role owner/);
    expect(counts(f)).toEqual([0, 0, 0]);
  });

  it('checks process role and explicit boolean even when called directly', () => {
    const f = fixture();
    for (const context of [
      { ...f.context, enableC2CController: undefined },
      { ...f.context, enableC2CController: false },
      { ...f.context, enableC2CController: 'true' as never },
      { ...f.context, processRole: 'junior' as ProcessRole },
      { ...f.context, processRole: 'principal' as ProcessRole },
    ]) expect(executeC2CPlan(context, f.request)).toMatchObject({ ok: false, stage: 'input', error: { code: 'CONTROLLER_DISABLED' } });
    expect(counts(f)).toEqual([0, 0, 0]);
  });

  it('rejects all extra execution/authority fields through the real MCP tool before any durable phase', async () => {
    const f = fixture();
    const c = await controllerConnection(f.context); connections.push(c);
    const evaluate = vi.spyOn(evaluationApi, 'durableEvaluateC2CMessage');
    for (const field of ['actor_role', 'trusted_actor_context', 'repo_root', 'database_path', 'adapter', 'adapter_id', 'target_schema', 'command', 'executable', 'argv', 'environment', 'cwd', 'manifest', 'launch_spec', 'pid', 'runner_instance_id', 'execution_instance_id']) {
      const input = { ...f.request, [field]: 'MUST_NOT_GRANT_AUTHORITY' };
      expect(executeC2CPlanInputSchema.safeParse(input).success).toBe(false);
      expect((await c.client.callTool({ name: 'execute_c2c_plan', arguments: input })).isError).toBe(true);
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(counts(f)).toEqual([0, 0, 0]);
  });

  it('keeps frozen nested strictness, size limit, PLAN gate, and sender consistency', () => {
    const f = fixture();
    for (const state of ['INIT', 'EXECUTED', 'DONE', 'BLOCKED', 'ERROR']) {
      const result = executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, state, ...(state === 'ERROR' ? { error: 'fixture' } : {}) } });
      expect(result).toMatchObject({ ok: false, stage: 'input', error: { code: 'NOT_PLAN' } });
    }
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, executable: 'bad' } })).toMatchObject({ ok: false });
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, evidence_refs: Array(40).fill('x'.repeat(2048)) } })).toMatchObject({ ok: false, error: { code: 'MESSAGE_TOO_LARGE' } });
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, sender_role: 'JUNIOR' } })).toMatchObject({ ok: false, stage: 'evaluation', error: { code: 'SENDER_ROLE_MISMATCH' } });
    expect(executeC2CPlan(f.context, {
      ...f.request,
      plan_message: { ...f.request.plan_message, protocol_version: 'engineering-c2c/999' },
    })).toMatchObject({
      ok: false,
      stage: 'input',
      error: { code: 'INVALID_PROTOCOL_VERSION' },
    });
    expect(counts(f)).toEqual([0, 0, 0]);
  });

  it('fails a foreign trusted repository and never auto-creates a missing task', () => {
    const f = fixture();
    expect(executeC2CPlan({ ...f.context, repoPath: 'C:\\foreign' }, f.request)).toMatchObject({ ok: false, stage: 'evaluation', error: { code: 'REPOSITORY_MISMATCH' } });
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, task_id: 'absent-task' } })).toMatchObject({ ok: false, stage: 'evaluation', error: { code: 'TASK_MISMATCH' } });
    expect(f.store.getTask('absent-task')).toBeUndefined();
    expect(counts(f)).toEqual([0, 0, 0]);
  });
});
describe('production C2C frozen phase orchestration', () => {
  it('runs public tool -> four real phases -> native Harness -> terminal lifecycle and S2', async () => {
    const f = fixture(); const launch = trackLaunch();
    const c = await controllerConnection(f.context); connections.push(c);
    const response = await c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request });
    expect(response.isError).toBeFalsy();
    const result = executeC2CPlanOutputSchema.parse(response.structuredContent);
    expect(result).toMatchObject({ ok: true, stage: 'launch', evaluation: { decision: 'REQUIRES_OWNER_ACTION', evaluated_revision: 1 }, acceptance: { decision: 'ACCEPTED' }, delegation: { decision: 'CREATED' }, launch: { physical_spawn_requested: true, physical_spawn_observed: true } });
    const receipt = await completed(f);
    expect(result.delegation?.dispatch_run_id).toBe(receipt.dispatch_run_id);
    expect(result.acceptance?.command_id).toBe(f.store.getPlanAcceptanceReceipt(f.request.acceptance_command_id)?.command_id);
    expect(counts(f)).toEqual([1, 1, 1]);
    expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe('native harness edit\n');
    const evidence = { trusted_repo_root: f.repo, task: f.store.getTask(f.task.id)!, task_events: f.store.listEvents(f.task.id), dispatch: f.store.getDispatchRun(receipt.dispatch_run_id)! };
    const selector = { task_id: f.task.id, dispatch_run_id: receipt.dispatch_run_id };
    expect(executionOutput(evidence, selector)).toMatchObject({ ok: true, value: { worker_reported: { verification: 'REPORTED' }, runner_observed: { verification: 'VERIFIED' } } });
    expect(testStatus(evidence, selector)).toMatchObject({ ok: true, value: { overall: { result: 'PASSED', verification: 'REPORTED' } } });
    const before = storedTarget(f);
    const replay = await c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request });
    expect(replay.structuredContent).toMatchObject({ ok: true, evaluation: { decision: 'NOOP_WITH_EXISTING_RECEIPT' }, acceptance: { decision: 'NOOP_WITH_EXISTING_ACCEPTANCE' }, delegation: { decision: 'NOOP_WITH_EXISTING_DELEGATION' }, launch: { state: 'TERMINAL', physical_spawn_requested: false, physical_spawn_observed: false } });
    expect(children).toHaveLength(1);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(storedTarget(f)).toEqual(before);
    const json = JSON.stringify(response);
    for (const secret of ['launch_spec', 'executable_path', 'metadata-private-sentinel', 'capabilities-private-sentinel', 'runner_instance_id', 'environment', 'native harness progress']) expect(json).not.toContain(secret);
  });

  it.each(['evaluation', 'acceptance', 'delegation', 'launch'] as const)('reopens and resumes exact identities after response loss after %s', async (phase) => {
    const f = fixture(); const launch = trackLaunch();
    const failure = () => { throw new Error('PRIVATE_UPSTREAM_ERROR_MUST_NOT_ESCAPE'); };
    if (phase === 'evaluation') vi.spyOn(evaluationApi, 'durableEvaluateC2CMessage').mockImplementationOnce((...args) => { realEvaluate(...args); return failure(); });
    if (phase === 'acceptance') vi.spyOn(acceptanceApi, 'acceptEvaluatedPlan').mockImplementationOnce((...args) => { realAccept(...args); return failure(); });
    if (phase === 'delegation') vi.spyOn(delegationApi, 'createAcceptedDispatchIntent').mockImplementationOnce((...args) => { realDelegate(...args); return failure(); });
    if (phase === 'launch') launch.mockImplementationOnce((...args) => { trackedLaunch(...args); return failure(); });
    const first = executeC2CPlan(f.context, f.request);
    expect(first).toMatchObject({ ok: false, stage: phase, error: { code: 'CONTROLLER_PHASE_FAILED' } });
    expect(JSON.stringify(first)).not.toContain('PRIVATE_UPSTREAM');
    expect(counts(f)).toEqual(phase === 'evaluation' ? [1, 0, 0] : phase === 'acceptance' ? [1, 1, 0] : [1, 1, 1]);
    const originalEvaluation = f.store.getC2CEvaluationReceipt(f.request.plan_message.message_id);
    const originalAcceptance = f.store.getPlanAcceptanceReceipt(f.request.acceptance_command_id);
    const originalDispatch = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)?.dispatch_run_id;
    const old = f.store; const path = old.path;
    old.close(); stores.splice(stores.indexOf(old), 1);
    f.store = Store.open(path, { repoRoot: f.repo }); stores.push(f.store); f.context.store = f.store;
    // Once delegated, neither original files nor current profile registry determine replay.
    if (originalDispatch) {
      writeFileSync(f.manifestPath, 'invalid after authorization');
      f.context.workerProfiles = { defaultProfile: 'missing', sourcePath: null, profiles: new Map() };
    }
    const retry = executeC2CPlan(f.context, f.request);
    expect(retry.ok).toBe(true);
    const receipt = await completed(f);
    expect(f.store.getC2CEvaluationReceipt(f.request.plan_message.message_id)).toEqual(originalEvaluation);
    if (originalAcceptance) expect(f.store.getPlanAcceptanceReceipt(f.request.acceptance_command_id)).toEqual(originalAcceptance);
    if (originalDispatch) expect(receipt.dispatch_run_id).toBe(originalDispatch);
    expect(counts(f)).toEqual([1, 1, 1]);
  });

  it('simultaneous public requests still have one durable dispatch and one authoritative execution', async () => {
    const f = fixture(); trackLaunch();
    const a = await controllerConnection(f.context), b = await controllerConnection(f.context);
    connections.push(a, b);
    const responses = await Promise.all([a, b].map((c) => c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request })));
    expect(responses.every((r) => !r.isError)).toBe(true);
    const receipt = await completed(f);
    for (const r of responses) expect(r.structuredContent).toMatchObject({ delegation: { dispatch_run_id: receipt.dispatch_run_id } });
    expect(counts(f)).toEqual([1, 1, 1]);
  });

  it('does not report successful execution when only a physical attempt was requested and failed', () => {
    const f = fixture(); noPhysicalLaunch();
    const result = executeC2CPlan(f.context, f.request);
    expect(result).toMatchObject({ ok: true, launch: { state: 'SPAWNED', dispatch_status: 'launching', task_status: 'READY', physical_spawn_requested: true, physical_spawn_observed: false } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_LAUNCH_TEXT');
    expect(f.store.getTask(f.task.id)?.revision).toBe(1);
  });

  it('rejects acceptance/delegation identity conflicts without target replacement or fallback', () => {
    const f = fixture(); const launch = noPhysicalLaunch();
    expect(executeC2CPlan(f.context, f.request).ok).toBe(true);
    const target = storedTarget(f);
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, message_id: 'different-plan', goal: 'different PLAN' } })).toMatchObject({ ok: false, stage: 'acceptance', error: { code: 'COMMAND_ID_CONFLICT' } });
    expect(executeC2CPlan(f.context, { ...f.request, worker_profile_id: 'different-profile' })).toMatchObject({ ok: false, stage: 'delegation', error: { code: 'COMMAND_ID_CONFLICT' } });
    expect(executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, goal: 'same id changed content' } })).toMatchObject({ ok: false, stage: 'evaluation', error: { code: 'MESSAGE_ID_CONFLICT' } });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(storedTarget(f)).toEqual(target);
  });

  it.each(['BLOCKED', 'FAILED', 'COMPLETED', 'RUNNING', 'CANCELLED', 'CLOSED'] as const)('never resumes/recovers/creates to execute a fresh PLAN against %s', (state) => {
    const f = fixture(); const launch = vi.spyOn(launchApi, 'launchControlledC2CWorker');
    let task = f.task;
    if (state === 'CANCELLED' || state === 'CLOSED') {
      task = cancelTask(f.store, task.id, task.revision, 'fixture');
      if (state === 'CLOSED') task = closeTask(f.store, task.id, task.revision, 'fixture close');
    } else {
      task = claimTask(f.store, snapshot(f.repo), 'JUNIOR', 'fixture-runner', task.id, task.revision);
      if (state === 'BLOCKED') task = reportBlocked(f.store, 'JUNIOR', 'fixture-runner', { task_id: task.id, revision: task.revision, blocker: { reason: 'OTHER', summary: 'fixture', need_from_owner: 'review', evidence_refs: [] } });
      else if (state !== 'RUNNING') task = reportResult(f.store, 'JUNIOR', 'fixture-runner', { task_id: task.id, revision: task.revision, outcome: state === 'FAILED' ? 'failed' : 'completed', result: implResult });
    }
    const events = f.store.listEvents(task.id);
    const result = executeC2CPlan(f.context, { ...f.request, plan_message: { ...f.request.plan_message, expected_revision: task.revision } });
    expect(result.ok).toBe(false);
    expect(f.store.getTask(task.id)).toEqual(task);
    expect(f.store.listEvents(task.id)).toEqual(events);
    expect(f.store.listDispatchRunsForTask(task.id)).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it('stops on unknown profile and DIAGNOSIS, without invoking controlled launch', () => {
    const f = fixture(); const launch = vi.spyOn(launchApi, 'launchControlledC2CWorker');
    expect(executeC2CPlan(f.context, { ...f.request, worker_profile_id: 'absent-profile' })).toMatchObject({ ok: false, stage: 'delegation', error: { code: 'LAUNCH_TARGET_UNSUPPORTED' } });
    const task = createTask(f.store, snapshot(f.repo), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    expect(executeC2CPlan(f.context, { ...f.request, acceptance_command_id: 'diagnosis-accept', delegation_command_id: 'diagnosis-delegate', plan_message: { ...f.request.plan_message, message_id: 'diagnosis-plan', task_id: task.id } })).toMatchObject({ ok: false, stage: 'delegation', error: { code: 'WRONG_TASK_TYPE' } });
    expect(launch).not.toHaveBeenCalled();
  });

  it('uses frozen ALREADY_CLAIMED handling rather than inferring a new launch', () => {
    const f = fixture(); noPhysicalLaunch();
    expect(executeC2CPlan(f.context, f.request).ok).toBe(true);
    vi.restoreAllMocks();
    const receipt = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)!;
    // Authoritative claim uses the original lifecycle, not the controller.
    const db = f.store;
    return import('../src/lifecycle.ts').then(({ claimC2CDispatchTask }) => {
      claimC2CDispatchTask(db, snapshot(f.repo), 'held-worker', receipt.dispatch_run_id);
      expect(executeC2CPlan(f.context, f.request)).toMatchObject({ ok: true, launch: { state: 'ALREADY_CLAIMED', physical_spawn_requested: false } });
    });
  });

  it('fails closed on an inconsistent launch snapshot without inventing state or spawning', () => {
    const f = fixture(); noPhysicalLaunch();
    expect(executeC2CPlan(f.context, f.request).ok).toBe(true);
    vi.restoreAllMocks();
    const receipt = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)!;
    const original = f.store.getDispatchRun(receipt.dispatch_run_id)!;
    const task = f.store.getTask(f.task.id);
    const before = storedTarget(f);
    vi.spyOn(f.store, 'getDispatchRun').mockReturnValue({ ...original, runner_instance_id: 'inconsistent-fixture' });
    expect(executeC2CPlan(f.context, f.request)).toMatchObject({ ok: false, stage: 'launch', error: { code: 'CONTROLLER_PHASE_FAILED' } });
    expect(f.store.getTask(f.task.id)).toEqual(task);
    expect(storedTarget(f)).toEqual(before);
    expect(children).toHaveLength(0);
  });

  it('runs the same controller with the frozen exact Codex consumer using only trusted test seams', async () => {
    const f = fixture(); const exe = join(f.assets, 'fake-codex.exe');
    writeFileSync(exe, 'frozen fake codex artifact');
    f.context.workerProfiles = builtinWorkerProfiles(); f.request.worker_profile_id = 'codex-luna';
    const build = codexBuilder.buildSecretSafeCodexLunaLaunchSpecV1;
    vi.spyOn(codexBuilder, 'buildSecretSafeCodexLunaLaunchSpecV1').mockImplementation((profiles, id) => build(profiles, id, { platform: 'win32', env: {}, resolveLauncher: () => ({ kind: 'native', executable: exe, displayPath: exe }) }));
    noPhysicalLaunch();
    const result = executeC2CPlan(f.context, f.request);
    expect(result.ok).toBe(true);
    const receipt = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)!;
    expect(receipt.launch_spec.schema).toBe('engineering-launch/1');
    const spawnProcess = vi.fn((executable: string, args: string[], options: { cwd: string; shell: false; windowsHide: true }) => {
      expect(executable).toBe(receipt.launch_spec.launcher.executable_path);
      expect(options).toMatchObject({ cwd: f.repo, shell: false });
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234 }) as unknown as ChildProcessWithoutNullStreams;
      (child.stdin as PassThrough).resume();
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify({ outcome: 'completed', summary: 'deterministic exact Codex', changed_files: [], validation: [], known_limitations: [], exit_code: 0 }));
      setImmediate(() => child.emit('close', 0, null));
      return child;
    });
    const terminal = await runC2CWorkerRunner({ store: f.store, git: snapshot(f.repo), dispatchRunId: receipt.dispatch_run_id, executionInstanceId: 'controller-fake-codex', adapterOptions: { platform: 'win32', spawnProcess } });
    expect(terminal.status).toBe('COMPLETED');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(f.store.listEvents(f.task.id).filter((e) => e.kind === 'claimed')).toHaveLength(1);
    expect(executeC2CPlan(f.context, f.request)).toMatchObject({ ok: true, launch: { state: 'TERMINAL', physical_spawn_requested: false } });
  });

  it('adds no controller storage, provider branch, lifecycle implementation, or new schema version', () => {
    const source = readFileSync(join(projectRoot, 'src/c2c/controller.ts'), 'utf8');
    expect(source).not.toMatch(/codex|grok|generic-cli|createTask|resumeTask|recoverTask|claimC2CDispatchTask|\.transact\(|insertEvent|insertDispatch/i);
    expect(SCHEMA_VERSION).toBe(12); expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    const f = fixture(); noPhysicalLaunch();
    const db = new DatabaseSync(f.store.path, { readOnly: true });
    try {
      const schema = db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all();
      executeC2CPlan(f.context, f.request);
      expect(db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
    } finally { db.close(); }
  });
});
