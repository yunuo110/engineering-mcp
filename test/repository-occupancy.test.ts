import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { cancelTask, checkpointTask, claimC2CDispatchTask, claimTask, closeTask, createTask,
  recoverTask, reportResult, resumeTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import * as executionGroup from '../src/orchestration/execution-group.ts';
import * as trustedRuntime from '../src/orchestration/trusted-runtime.ts';
import { assertRepositoryWriterAdmission, recordRepositoryLaunchRequest } from '../src/orchestration/repository-occupancy.ts';
import { Store } from '../src/store.ts';
import { createEngineeringServer } from '../src/server.ts';
import type { TaskContract } from '../src/types.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import { connectInProcess, expectDomain, git, implPayload, implResult, initGitRepo, openTempStore,
  removeDir, snapshot } from './helpers.ts';

const stores: Store[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
const connections: Array<{ close: () => Promise<void> }> = [];
const descendantDrains: Array<() => Promise<void>> = [];
async function finish(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin!.end();
  await exited;
}
afterEach(async () => {
  for (const drain of descendantDrains.splice(0)) await drain();
  for (const child of children.splice(0)) await finish(child);
  for (const connection of connections.splice(0)) await connection.close();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});
function setup() {
  const repo = initGitRepo(); dirs.push(repo);
  const opened = openTempStore(repo); stores.push(opened.store); dirs.push(opened.dir);
  const executable = join(opened.dir, 'hashed-fixture.exe');
  writeFileSync(executable, 'not executed: durable target hashing fixture');
  const create = () => createTask(opened.store, snapshot(repo), {
    type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: ['README.md'] },
  });
  return { repo, store: opened.store, executable, create };
}
function reserve(store: Store, repo: string, task: TaskContract, executable: string) {
  const owner = { actor_role: 'OWNER' as const, repo_root: repo };
  const message = { protocol_version: 'engineering-c2c/1' as const, message_id: `plan-${task.id}`,
    task_id: task.id, sender_role: 'OWNER' as const, state: 'PLAN' as const,
    expected_revision: task.revision, goal: 'isolated occupancy fixture' };
  expect(['REQUIRES_OWNER_ACTION', 'NOOP_WITH_EXISTING_RECEIPT'])
    .toContain(durableEvaluateC2CMessage(store, message, owner).decision);
  expect(['ACCEPTED', 'NOOP_WITH_EXISTING_ACCEPTANCE'])
    .toContain(acceptEvaluatedPlan(store, { command_id: `accept-${task.id}`, plan_message: message }, owner).decision);
  return createAcceptedDispatchIntent(store, { command_id: `delegate-${task.id}`,
    acceptance_command_id: `accept-${task.id}`, worker_profile_id: 'codex-luna' }, owner, builtinWorkerProfiles(), {
    launchSpecBuildOptions: { platform: 'win32', env: {}, resolveLauncher: () => ({
      kind: 'native', executable, displayPath: executable,
    }) },
  });
}
function reservedId(result: ReturnType<typeof reserve>): string {
  expect(result.decision).toBe('CREATED');
  if (result.decision !== 'CREATED') throw new Error('fixture delegation was not created');
  return result.receipt.dispatch_run_id;
}
async function waitingProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdout.write('ready\\n');"], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot },
  });
  children.push(child);
  await once(child.stdout!, 'data');
  return child;
}
async function survivingDescendant(exitPath: string) {
  const descendantCode = `const fs=require('node:fs'); process.stdout.write(String(process.pid)+'\\n'); process.send('ready'); process.disconnect(); setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitPath)}))process.exit(0);},20);`;
  const rootCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','inherit','ignore','ipc'],detached:true,windowsHide:true}); child.once('message',()=>{child.unref();process.exit(0);});`;
  const root = spawn(process.execPath, ['-e', rootCode], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot },
  });
  let drained = false;
  const closed = new Promise<void>((resolve) => root.once('close', () => { drained = true; resolve(); }));
  const drain = async () => { writeFileSync(exitPath, 'drain'); await closed; };
  descendantDrains.push(drain);
  const [chunk] = await once(root.stdout!, 'data');
  const pid = Number(String(chunk).trim());
  if (root.exitCode === null) await once(root, 'exit');
  expect(root.exitCode).toBe(0);
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).not.toThrow();
  return { pid, isDrained: () => drained, drain };
}
async function cancellationClient(repo: string, store: Store, operation: 'cancel_task' | 'cancel_work_task') {
  if (operation === 'cancel_task') {
    const connection = await connectInProcess('owner', repo, store);
    connections.push(connection);
    return connection.client;
  }
  const server = createEngineeringServer({ processRole: 'owner', repoPath: repo, store,
    executionInstanceId: 'private-work-owner', workerProfiles: builtinWorkerProfiles(),
    workPrivateClient: true, workContractVersion: 'engineering-work/1' });
  const client = new Client({ name: 'private-work-occupancy-fixture', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  connections.push({ close: async () => { await client.close(); await server.close(); } });
  return client;
}

describe('repository occupancy independent of Task state', () => {
  it.each(['cancel_task', 'cancel_work_task'] as const)('%s and close cannot admit another Task while the old process is ALIVE or evidence is UNKNOWN', async (operation) => {
    const f = setup();
    const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    recordRepositoryLaunchRequest(f.store, f.repo, dispatchId);
    const running = claimC2CDispatchTask(f.store, snapshot(f.repo), 'runner-a', dispatchId);
    const child = await waitingProcess();
    // This exercises real process lifetime with an isolated mocked Keeper query,
    // not native Job/ACL proof. Native witness integration is tested separately.
    const observe = vi.spyOn(executionGroup, 'observeExecutionGroup').mockImplementation(() =>
      child.exitCode === null ? { state: 'ALIVE', active_processes: 1, process_ids: [child.pid!] }
        : { state: 'DRAINED', active_processes: 0, process_ids: [] });
    const client = await cancellationClient(f.repo, f.store, operation);
    const response = await client.callTool({ name: operation, arguments: { task_id: a.id, revision: running.revision } });
    expect(response.isError).toBeFalsy();
    const cancelled = f.store.getTask(a.id)!;
    closeTask(f.store, cancelled.id, cancelled.revision);
    expect(child.exitCode).toBeNull();
    const b = f.create();
    for (const state of ['ALIVE', 'UNKNOWN'] as const) {
      observe.mockReturnValue(state === 'ALIVE'
        ? { state, active_processes: 1, process_ids: [child.pid!] } : { state });
      expectDomain(() => claimTask(f.store, snapshot(f.repo), 'JUNIOR', 'runner-b', b.id, b.revision), 'REPOSITORY_WRITER_OCCUPIED');
      await expect(delegateTask(f.store, snapshot(f.repo), b.id, b.revision,
        { adapterId: 'unused', wait: false })).rejects.toMatchObject({ code: 'REPOSITORY_WRITER_OCCUPIED' });
      expect(reserve(f.store, f.repo, b, f.executable)).toMatchObject({ decision: 'REJECT', code: 'REPOSITORY_WRITER_OCCUPIED' });
      expect(f.store.listDispatchRunsForTask(b.id)).toHaveLength(0);
    }
    await finish(child);
    observe.mockReturnValue({ state: 'DRAINED', active_processes: 0, process_ids: [] });
    const second = reservedId(reserve(f.store, f.repo, b, f.executable));
    recordRepositoryLaunchRequest(f.store, f.repo, second);
    expect(claimC2CDispatchTask(f.store, snapshot(f.repo), 'runner-b', second).status).toBe('RUNNING');
  });

  it('terminal Task with a surviving descendant denies checkpoint until the group drains', async () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    recordRepositoryLaunchRequest(f.store, f.repo, dispatchId);
    const running = claimC2CDispatchTask(f.store, snapshot(f.repo), 'runner-a', dispatchId);
    const descendant = await survivingDescendant(join(f.store.path, '..', 'descendant-exit'));
    const observe = vi.spyOn(executionGroup, 'observeExecutionGroup').mockReturnValue({
      state: 'ALIVE', active_processes: 1, process_ids: [descendant.pid],
    });
    writeFileSync(join(f.repo, 'README.md'), 'valuable output\n');
    const terminal = reportResult(f.store, 'JUNIOR', 'runner-a', { task_id: a.id, revision: running.revision,
      outcome: 'completed', result: { ...implResult, changed_files: ['README.md'] } },
    { ...f.store.getDispatchRun(dispatchId)!, status: 'completed' });
    const head = git(f.repo, ['rev-parse', 'HEAD']);
    expectDomain(() => checkpointTask(f.store, snapshot(f.repo), { task_id: a.id,
      revision: terminal.revision, purpose: 'REVIEW' }), 'REPOSITORY_WRITER_OCCUPIED');
    expect(f.store.listCheckpoints(a.id)).toHaveLength(0);
    expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(descendant.isDrained()).toBe(false);
    await descendant.drain();
    observe.mockReturnValue({ state: 'DRAINED', active_processes: 0, process_ids: [] });
    const saved = checkpointTask(f.store, snapshot(f.repo), { task_id: a.id, revision: terminal.revision, purpose: 'REVIEW' });
    expect(git(f.repo, ['show', `${saved.checkpoint.checkpoint_commit}:README.md`])).toBe('valuable output');
  });

  it('REQUESTED occupancy survives restart, missing witness, cancellation and close', () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    recordRepositoryLaunchRequest(f.store, f.repo, dispatchId);
    const running = claimC2CDispatchTask(f.store, snapshot(f.repo), 'dead-runner', dispatchId);
    const observe = vi.spyOn(executionGroup, 'observeExecutionGroup').mockReturnValue({ state: 'UNKNOWN' });
    f.store.close();
    const restarted = Store.open(f.store.path, { repoRoot: f.repo }); stores.push(restarted);
    expect(restarted.getRepositoryLaunchState(dispatchId)).toBe('REQUESTED');
    expectDomain(() => recoverTask(restarted, snapshot(f.repo), { task_id: a.id, revision: running.revision }), 'REPOSITORY_WRITER_OCCUPIED');
    const cancelled = cancelTask(restarted, a.id, running.revision);
    closeTask(restarted, a.id, cancelled.revision);
    expectDomain(() => assertRepositoryWriterAdmission(restarted, f.repo), 'REPOSITORY_WRITER_OCCUPIED');
    observe.mockReturnValue({ state: 'DRAINED', active_processes: 0, process_ids: [] });
    expect(() => assertRepositoryWriterAdmission(restarted, f.repo)).not.toThrow();
  });

  it('only the durable NOT_REQUESTED receipt releases a cancelled unlaunched reservation', () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    expect(f.store.getRepositoryLaunchState(dispatchId)).toBe('NOT_REQUESTED');
    expectDomain(() => assertRepositoryWriterAdmission(f.store, f.repo), 'REPOSITORY_WRITER_OCCUPIED');
    cancelTask(f.store, a.id, a.revision);
    expect(() => assertRepositoryWriterAdmission(f.store, f.repo)).not.toThrow();
    expectDomain(() => recordRepositoryLaunchRequest(f.store, f.repo, dispatchId), 'REPOSITORY_WRITER_OCCUPIED');
    expect(f.store.getRepositoryLaunchState(dispatchId)).toBe('NOT_REQUESTED');
  });

  it('launch request is single-use and only its exact active reservation is exempt', () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    expect(() => assertRepositoryWriterAdmission(f.store, f.repo, { currentDispatchId: dispatchId })).not.toThrow();
    expectDomain(() => assertRepositoryWriterAdmission(f.store, f.repo, { currentDispatchId: 'foreign' }), 'REPOSITORY_WRITER_OCCUPIED');
    recordRepositoryLaunchRequest(f.store, f.repo, dispatchId);
    expectDomain(() => recordRepositoryLaunchRequest(f.store, f.repo, dispatchId), 'REPOSITORY_WRITER_OCCUPIED');
  });

  it('an older dispatch without a launch receipt is UNKNOWN, never a never-requested release', () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    const raw = new DatabaseSync(f.store.path);
    raw.prepare('DELETE FROM ledger_metadata WHERE key = ?').run(`repository_launch:${dispatchId}`);
    raw.close();
    cancelTask(f.store, a.id, a.revision);
    vi.spyOn(executionGroup, 'observeExecutionGroup').mockReturnValue({ state: 'UNKNOWN' });
    expect(f.store.getRepositoryLaunchState(dispatchId)).toBeUndefined();
    expectDomain(() => assertRepositoryWriterAdmission(f.store, f.repo), 'REPOSITORY_WRITER_OCCUPIED');
  });

  it('a READY reservation excludes another Task across ledger connections before any process exists', () => {
    const f = setup(); const a = f.create(); const b = f.create();
    const first = reservedId(reserve(f.store, f.repo, a, f.executable));
    const other = Store.open(f.store.path, { repoRoot: f.repo }); stores.push(other);
    expect(reserve(other, f.repo, b, f.executable)).toMatchObject({ decision: 'REJECT', code: 'REPOSITORY_WRITER_OCCUPIED' });
    expect(other.listDispatchRunsForTask(b.id)).toHaveLength(0);
    expect(other.getRepositoryLaunchState(first)).toBe('NOT_REQUESTED');
    cancelTask(f.store, a.id, a.revision);
    expect(reserve(other, f.repo, b, f.executable).decision).toBe('CREATED');
  });

  it('recovery and resume require drain across all tasks, not just the recovered task', () => {
    const f = setup(); const a = f.create();
    const dispatchId = reservedId(reserve(f.store, f.repo, a, f.executable));
    recordRepositoryLaunchRequest(f.store, f.repo, dispatchId);
    const running = claimC2CDispatchTask(f.store, snapshot(f.repo), 'runner-a', dispatchId);
    const observe = vi.spyOn(executionGroup, 'observeExecutionGroup').mockReturnValue({ state: 'DRAINED', active_processes: 0, process_ids: [] });
    const recovered = recoverTask(f.store, snapshot(f.repo), { task_id: a.id, revision: running.revision });
    observe.mockReturnValue({ state: 'UNKNOWN' });
    expectDomain(() => resumeTask(f.store, snapshot(f.repo), { task_id: a.id, revision: recovered.revision }), 'REPOSITORY_WRITER_OCCUPIED');
  });

  it('protected execution refuses unmanaged claim/delegation and enforces the protected ledger binding', async () => {
    const f = setup(); const task = f.create();
    const baseline = snapshot(f.repo);
    vi.spyOn(trustedRuntime, 'isProtectedExecutionMode').mockReturnValue(true);
    const binding = vi.spyOn(trustedRuntime, 'assertProtectedRepositoryBinding').mockImplementation(() => { throw new Error('binding refused'); });
    expectDomain(() => claimTask(f.store, baseline, 'JUNIOR', 'unmanaged', task.id, task.revision), 'ROLE_FORBIDDEN');
    await expect(delegateTask(f.store, baseline, task.id, task.revision,
      { adapterId: 'unused', wait: false })).rejects.toMatchObject({ code: 'ROLE_FORBIDDEN' });
    expect(() => assertRepositoryWriterAdmission(f.store, f.repo)).toThrow('binding refused');
    expect(binding).toHaveBeenCalledWith(f.store.path, f.repo);
  });

  it.each(['RUNNING', 'CLOSED'] as const)('protected execution rejects legacy %s claims without dispatch drain inventory', (status) => {
    const f = setup(); const task = f.create(); const baseline = snapshot(f.repo);
    const running = claimTask(f.store, baseline, 'JUNIOR', 'legacy-manual-owner', task.id, task.revision);
    if (status === 'CLOSED') {
      const cancelled = cancelTask(f.store, task.id, running.revision);
      closeTask(f.store, task.id, cancelled.revision);
    }
    vi.spyOn(trustedRuntime, 'isProtectedExecutionMode').mockReturnValue(true);
    vi.spyOn(trustedRuntime, 'assertProtectedRepositoryBinding').mockImplementation(() => {});
    expect(f.store.listRepositoryDispatchRuns(f.repo)).toHaveLength(0);
    expectDomain(() => assertRepositoryWriterAdmission(f.store, f.repo), 'REPOSITORY_WRITER_OCCUPIED');
    if (status === 'RUNNING') {
      expectDomain(() => recoverTask(f.store, baseline, { task_id: task.id, revision: running.revision }),
        'REPOSITORY_WRITER_OCCUPIED');
      expect(f.store.getTask(task.id)?.status).toBe('RUNNING');
    }
  });
});
