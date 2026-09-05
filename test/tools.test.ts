import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectInProcess,
  diagnosisPayload,
  implPayload,
  implResult,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  type Connected,
} from './helpers.ts';
import { claimTask, createTask, reportBlocked, reportResult } from '../src/lifecycle.ts';
import type { Store } from '../src/store.ts';

const DIRECT_INSTANCE = 'direct-instance';
const dirs: string[] = [];
const stores: Store[] = [];
const connections: Connected[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

async function ownerSession(): Promise<{ repo: string; db: Store; owner: Connected }> {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  const owner = await connectInProcess('owner', repo, opened.store);
  connections.push(owner);
  return { repo, db: opened.store, owner };
}

describe('role-filtered tools', () => {
  it('registers only owner tools on an owner process', async () => {
    const { owner } = await ownerSession();
    const listed = await owner.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'await_delegation',
      'cancel_task',
      'close_task',
      'create_task',
      'delegate_task',
      'get_task',
      'list_active_tasks',
      'list_worker_profiles',
      'recover_task',
      'resume_task',
    ]);
  });

  it('registers only worker tools on junior and principal processes', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const junior = await connectInProcess('junior', repo, opened.store);
    const principal = await connectInProcess('principal', repo, opened.store);
    connections.push(junior, principal);
    const juniorTools = (await junior.client.listTools()).tools.map((tool) => tool.name).sort();
    const principalTools = (await principal.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(juniorTools).toEqual([
      'claim_next_task',
      'claim_task',
      'get_task',
      'report_blocked',
      'report_result',
    ]);
    expect(principalTools).toEqual(juniorTools);
  });

  it('creates a task with structured output and rejects a supplied branch', async () => {
    const { owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(created.isError).toBeFalsy();
    const body = structured(created);
    expect(body.ok).toBe(true);
    const task = body.task as { status: string; branch: string; id: string; revision: number };
    expect(task.status).toBe('READY');
    expect(task.branch.length).toBeGreaterThan(0);

    const rejected = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload, branch: 'sneaky' },
    });
    expect(rejected.isError).toBe(true);
    const text = rejected.content[0] && 'text' in rejected.content[0] ? rejected.content[0].text : '';
    expect(text).toContain('Unrecognized key: "branch"');
  });

  it('returns structured domain errors for worker visibility and claim rules', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const junior = await connectInProcess('junior', repo, db);
    connections.push(junior);
    const peek = await junior.client.callTool({
      name: 'get_task',
      arguments: { task_id: createdTask.id },
    });
    expect(peek.isError).toBe(true);
    expect(structured(peek).ok).toBe(false);
    expect((structured(peek).error as { code: string }).code).toBe('NOT_ASSIGNED');

    const claimed = await junior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimed.isError).toBeFalsy();
    const claimedTask = structured(claimed).task as {
      status: string;
      payload: { goal: string };
      revision: number;
      id: string;
    };
    expect(claimedTask.status).toBe('RUNNING');
    expect(claimedTask.payload.goal).toBe(implPayload.goal);

    const reported = await junior.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: claimedTask.id,
        revision: claimedTask.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(structured(reported).ok).toBe(true);
  });

  it('claims the oldest pending task through claim_next_task without leaking queue visibility', async () => {
    const { repo, db, owner } = await ownerSession();
    const first = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const firstTask = structured(first).task as { id: string };
    const second = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: { ...implPayload, goal: 'Second goal' } },
    });
    const secondTask = structured(second).task as { id: string };

    const junior = await connectInProcess('junior', repo, db);
    connections.push(junior);
    const claimed = await junior.client.callTool({
      name: 'claim_next_task',
      arguments: {},
    });
    expect(claimed.isError).toBeFalsy();
    expect((structured(claimed).task as { id: string; status: string }).id).toBe(firstTask.id);
    expect((structured(claimed).task as { status: string }).status).toBe('RUNNING');

    const peekSecond = await junior.client.callTool({
      name: 'get_task',
      arguments: { task_id: secondTask.id },
    });
    expect(peekSecond.isError).toBe(true);
    expect((structured(peekSecond).error as { code: string }).code).toBe('NOT_ASSIGNED');
  });

  it('does not auto-recover a RUNNING task when an owner server starts', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const git = snapshot(repo);
    const created = createTask(opened.store, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(opened.store, git, 'JUNIOR', DIRECT_INSTANCE, created.id, created.revision);
    expect(claimed.status).toBe('RUNNING');
    const eventsBefore = opened.store.listEvents(created.id).length;

    const owner = await connectInProcess('owner', repo, opened.store);
    connections.push(owner);
    const active = await owner.client.callTool({
      name: 'list_active_tasks',
      arguments: {},
    });
    const body = structured(active);
    const tasks = body.tasks as Array<{
      id: string;
      status: string;
      execution_instance_id: string | null;
      blocker: { reason: string; recovery?: { reason: string } } | null;
    }>;
    const task = tasks.find((item) => item.id === created.id);
    expect(task?.status).toBe('RUNNING');
    expect(task?.execution_instance_id).toBe(DIRECT_INSTANCE);
    expect(task?.blocker).toBeNull();
    expect(opened.store.listEvents(created.id)).toHaveLength(eventsBefore);
  });

  it('does not auto-recover a RUNNING task when a junior server starts', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const git = snapshot(repo);
    const created = createTask(opened.store, git, { type: 'IMPLEMENTATION', payload: implPayload });
    claimTask(opened.store, git, 'JUNIOR', DIRECT_INSTANCE, created.id, created.revision);

    const junior = await connectInProcess('junior', repo, opened.store);
    connections.push(junior);
    const got = await junior.client.callTool({
      name: 'get_task',
      arguments: { task_id: created.id },
    });
    const task = structured(got).task as {
      status: string;
      execution_instance_id: string | null;
      blocker: null | { reason: string };
    };
    expect(task.status).toBe('RUNNING');
    expect(task.execution_instance_id).toBe(DIRECT_INSTANCE);
    expect(task.blocker).toBeNull();
  });

  it('await_delegation materializes a completed dispatch in content.text', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const git = snapshot(repo);
    const claimed = claimTask(db, git, 'JUNIOR', 'owner-test-instance', createdTask.id, createdTask.revision);
    const completed = reportResult(db, 'JUNIOR', 'owner-test-instance', {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    const now = new Date().toISOString();
    db.insertDispatchRun({
      id: 'dispatch-completed',
      task_id: completed.id,
      worker_role: 'JUNIOR',
      adapter_id: 'codex-exec-luna',
      worker_profile_id: null,
      runner_instance_id: 'owner-test-instance',
      pid: 1,
      status: 'completed',
      started_at: now,
      finished_at: now,
      exit_code: 0,
      error_code: null,
      error_detail: null,
      created_at: now,
      updated_at: now,
    });
    const awaited = await owner.client.callTool({
      name: 'await_delegation',
      arguments: { dispatch_run_id: 'dispatch-completed' },
    });
    const text = awaited.content[0] && 'text' in awaited.content[0] ? awaited.content[0].text : '';
    expect(text).toContain('Task ID');
    expect(text).toContain('Dispatch Run ID');
    expect(text).toContain('Adapter: codex-exec-luna');
    expect(text).toContain('Outcome: completed');
    expect(text).toContain('Summary:');
  });

  it('delegate/await handback presents one coherent final working tree', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const git = snapshot(repo);
    const claimed = claimTask(db, git, 'JUNIOR', 'owner-test-instance', createdTask.id, createdTask.revision);
    const completed = reportResult(db, 'JUNIOR', 'owner-test-instance', {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: {
        ...implResult,
        summary: 'created host-smoke.txt',
        changed_files: ['host-smoke.txt'],
        working_tree_status: { clean: false, porcelain: '?? host-smoke.txt' },
      },
    });
    writeFileSync(join(repo, 'host-smoke.txt'), 'hello\n');
    const now = new Date().toISOString();
    db.insertDispatchRun({
      id: 'dispatch-host-smoke',
      task_id: completed.id,
      worker_role: 'JUNIOR',
      adapter_id: 'codex-exec-luna',
      worker_profile_id: null,
      runner_instance_id: 'owner-test-instance',
      pid: 1,
      status: 'completed',
      started_at: now,
      finished_at: now,
      exit_code: 0,
      error_code: null,
      error_detail: null,
      created_at: now,
      updated_at: now,
    });
    const awaited = await owner.client.callTool({
      name: 'await_delegation',
      arguments: { dispatch_run_id: 'dispatch-host-smoke' },
    });
    const text = awaited.content[0] && 'text' in awaited.content[0] ? awaited.content[0].text : '';
    expect(text).toContain('Final Working Tree Clean: false');
    expect(text).toContain('Final Working Tree Porcelain:');
    expect(text).toContain('?? host-smoke.txt');
    expect(text).not.toContain('\nWorking Tree Clean:');
  });

  it('await_delegation materializes a blocked dispatch in content.text', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const git = snapshot(repo);
    const claimed = claimTask(db, git, 'JUNIOR', 'owner-test-instance', createdTask.id, createdTask.revision);
    const blocked = reportBlocked(db, 'JUNIOR', 'owner-test-instance', {
      task_id: claimed.id,
      revision: claimed.revision,
      blocker: {
        reason: 'OTHER',
        summary: 'WORKER_PROTOCOL_FAILURE',
        need_from_owner: 'inspect worker output',
        evidence_refs: [],
      },
    });
    const now = new Date().toISOString();
    db.insertDispatchRun({
      id: 'dispatch-blocked',
      task_id: blocked.id,
      worker_role: 'JUNIOR',
      adapter_id: 'codex-exec-luna',
      worker_profile_id: null,
      runner_instance_id: 'owner-test-instance',
      pid: 1,
      status: 'blocked',
      started_at: now,
      finished_at: now,
      exit_code: 1,
      error_code: 'WORKER_PROTOCOL_FAILURE',
      error_detail: 'missing structured result',
      created_at: now,
      updated_at: now,
    });
    const awaited = await owner.client.callTool({
      name: 'await_delegation',
      arguments: { dispatch_run_id: 'dispatch-blocked' },
    });
    const text = awaited.content[0] && 'text' in awaited.content[0] ? awaited.content[0].text : '';
    expect(text).toContain('Outcome: blocked');
    expect(text).toContain('Blocker Reason: OTHER');
    expect(text).toContain('Error Code: WORKER_PROTOCOL_FAILURE');
  });

  it('await_delegation exposes DISPATCH_STILL_RUNNING when wait times out', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const git = snapshot(repo);
    const running = claimTask(db, git, 'JUNIOR', 'owner-test-instance', createdTask.id, createdTask.revision);
    const now = new Date().toISOString();
    db.insertDispatchRun({
      id: 'dispatch-running',
      task_id: running.id,
      worker_role: 'JUNIOR',
      adapter_id: 'codex-exec-luna',
      worker_profile_id: null,
      runner_instance_id: 'owner-test-instance',
      pid: 1,
      status: 'running',
      started_at: now,
      finished_at: null,
      exit_code: null,
      error_code: null,
      error_detail: null,
      created_at: now,
      updated_at: now,
    });
    const awaited = await owner.client.callTool({
      name: 'await_delegation',
      arguments: { dispatch_run_id: 'dispatch-running', timeout: 50 },
    });
    const text = awaited.content[0] && 'text' in awaited.content[0] ? awaited.content[0].text : '';
    expect(text).toContain('DISPATCH_STILL_RUNNING');
    expect(text).toContain('Dispatch Run ID: dispatch-running');
  });

  it('lets an OWNER explicitly recover a RUNNING task through recover_task', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const junior = await connectInProcess('junior', repo, db);
    connections.push(junior);
    const claimed = await junior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    const running = structured(claimed).task as { id: string; revision: number; status: string };
    expect(running.status).toBe('RUNNING');

    const recovered = await owner.client.callTool({
      name: 'recover_task',
      arguments: { task_id: running.id, revision: running.revision },
    });
    expect(recovered.isError).toBeFalsy();
    const recoveredTask = structured(recovered).task as {
      status: string;
      execution_instance_id: string | null;
      blocker: { reason: string; recovery?: { reason: string; retry_safe: boolean } };
    };
    expect(recoveredTask.status).toBe('BLOCKED');
    expect(recoveredTask.execution_instance_id).toBeNull();
    expect(recoveredTask.blocker.reason).toBe('CONTEXT_STALE');
    expect(recoveredTask.blocker.recovery?.reason).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(recoveredTask.blocker.recovery?.retry_safe).toBe(false);
  });
});