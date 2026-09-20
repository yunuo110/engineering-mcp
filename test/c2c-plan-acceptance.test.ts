import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import {
  cancelTask,
  claimTask,
  closeTask,
  createTask,
  reportBlocked,
  reportResult,
  resumeTask,
} from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import type { C2CMessage, TrustedActorContext } from '../src/c2c/schema.ts';
import type { TaskContract } from '../src/types.ts';
import {
  implPayload,
  implResult,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-plan-acceptance-worker.ts', import.meta.url),
);
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function setup() {
  const repo = initGitRepo();
  const opened = openTempStore(repo);
  dirs.push(repo, opened.dir);
  stores.push(opened.store);
  const task = createTask(opened.store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload: implPayload,
  });
  return { repo, store: opened.store, task };
}

function owner(repo: string): TrustedActorContext {
  return { actor_role: 'OWNER', repo_root: repo };
}

function plan(task: TaskContract, id: string): C2CMessage {
  return {
    protocol_version: 'engineering-c2c/1',
    message_id: id,
    task_id: task.id,
    sender_role: 'OWNER',
    state: 'PLAN',
    expected_revision: task.revision,
    goal: 'accepted plan',
  };
}

function evaluatePlan(
  store: Store,
  repo: string,
  task: TaskContract,
  id: string,
): C2CMessage {
  const message = plan(task, id);
  expect(
    durableEvaluateC2CMessage(store, message, owner(repo)).decision,
  ).toBe('REQUIRES_OWNER_ACTION');
  return message;
}

function command(id: string, message: C2CMessage) {
  return { command_id: id, plan_message: message };
}

function closeTracked(store: Store): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

function childRun(
  dbPath: string,
  repo: string,
  cmd: unknown,
  context: unknown,
  stage?: string,
) {
  return spawnSync(
    process.execPath,
    [
      fixture,
      '--store',
      dbPath,
      '--repo',
      repo,
      '--command',
      JSON.stringify(cmd),
      '--context',
      JSON.stringify(context),
      ...(stage ? ['--stage', stage] : []),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

function childAccept(
  dbPath: string,
  repo: string,
  cmd: unknown,
  context: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--store',
        dbPath,
        '--repo',
        repo,
        '--command',
        JSON.stringify(cmd),
        '--context',
        JSON.stringify(context),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'child failed'));
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

describe('S3B1 durable READY PLAN acceptance', () => {
  it('accepts one evaluated READY PLAN with normalized storage and zero domain mutation', () => {
    const { repo, store, task } = setup();
    const message = evaluatePlan(store, repo, task, 'plan-ready');
    const before = {
      task: store.getTask(task.id),
      events: store.listEvents(task.id),
      dispatches: store.listDispatchRunsForTask(task.id),
      checkpoints: store.listCheckpoints(task.id),
    };

    const result = acceptEvaluatedPlan(
      store,
      command('accept-ready', message),
      owner(repo),
    );
    expect(result).toMatchObject({
      decision: 'ACCEPTED',
      receipt: {
        command_id: 'accept-ready',
        evaluation_message_id: 'plan-ready',
        task_id: task.id,
        accepted_revision: task.revision,
      },
    });

    expect(store.getTask(task.id)).toEqual(before.task);
    expect(store.listEvents(task.id)).toEqual(before.events);
    expect(store.listDispatchRunsForTask(task.id)).toEqual(before.dispatches);
    expect(store.listCheckpoints(task.id)).toEqual(before.checkpoints);
    expect(store.getPlanAcceptanceReceipt('accept-ready')).toEqual(
      result.decision === 'ACCEPTED' ? result.receipt : undefined,
    );
  });

  it.each([
    'RUNNING',
    'BLOCKED',
    'FAILED',
    'COMPLETED',
    'CANCELLED',
    'CLOSED',
  ] as const)('rejects first acceptance when task is %s', (status) => {
    const { repo, store, task } = setup();
    let current = task;
    if (status === 'RUNNING' || status === 'BLOCKED' || status === 'FAILED' || status === 'COMPLETED') {
      current = claimTask(store, snapshot(repo), 'JUNIOR', 'runner', current.id, current.revision);
    }
    if (status === 'BLOCKED') {
      current = reportBlocked(store, 'JUNIOR', 'runner', {
        task_id: current.id,
        revision: current.revision,
        blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'resume', evidence_refs: [] },
      });
    } else if (status === 'FAILED' || status === 'COMPLETED') {
      current = reportResult(store, 'JUNIOR', 'runner', {
        task_id: current.id,
        revision: current.revision,
        outcome: status === 'FAILED' ? 'failed' : 'completed',
        result: implResult,
      });
    } else if (status === 'CANCELLED' || status === 'CLOSED') {
      current = cancelTask(store, current.id, current.revision);
      if (status === 'CLOSED') {
        current = closeTask(store, current.id, current.revision);
      }
    }

    const message = evaluatePlan(store, repo, current, 'plan-' + status);
    expect(
      acceptEvaluatedPlan(
        store,
        command('accept-' + status, message),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'TASK_NOT_READY',
    });
  });

  it('keeps resume separate and requires a newly evaluated PLAN on the new READY revision', () => {
    const { repo, store, task } = setup();
    const running = claimTask(store, snapshot(repo), 'JUNIOR', 'runner', task.id, task.revision);
    const blocked = reportBlocked(store, 'JUNIOR', 'runner', {
      task_id: running.id,
      revision: running.revision,
      blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'resume', evidence_refs: [] },
    });
    const oldPlan = evaluatePlan(store, repo, blocked, 'old-plan');
    const resumed = resumeTask(store, snapshot(repo), {
      task_id: blocked.id,
      revision: blocked.revision,
    });

    expect(
      acceptEvaluatedPlan(
        store,
        command('accept-old', oldPlan),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REVISION_MISMATCH',
    });

    const newPlan = evaluatePlan(store, repo, resumed, 'new-plan');
    expect(
      acceptEvaluatedPlan(
        store,
        command('accept-new', newPlan),
        owner(repo),
      ).decision,
    ).toBe('ACCEPTED');
  });

  it('enforces OWNER/repository admission and exact S3A PLAN identity', () => {
    const { repo, store, task } = setup();
    const message = evaluatePlan(store, repo, task, 'identity-plan');

    expect(
      acceptEvaluatedPlan(
        store,
        command('non-owner', message),
        { actor_role: 'JUNIOR', repo_root: repo },
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'ROLE_FORBIDDEN' });

    expect(
      acceptEvaluatedPlan(
        store,
        command('wrong-repo', message),
        { actor_role: 'OWNER', repo_root: repo + '-other' },
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'REPOSITORY_MISMATCH' });

    expect(
      acceptEvaluatedPlan(
        store,
        command('changed-message', { ...message, goal: 'changed' }),
        owner(repo),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'EVALUATION_MESSAGE_CONFLICT' });

    expect(
      acceptEvaluatedPlan(
        store,
        command('not-plan', { ...message, message_id: 'not-plan', state: 'DONE' }),
        owner(repo),
      ),
    ).toMatchObject({ decision: 'REJECT', code: 'NOT_PLAN' });
  });

  it('requires an S3A evaluation receipt and rejects READY_FOR_REVIEW as PLAN acceptance authority', () => {
    const { repo, store, task } = setup();
    const missing = plan(task, 'missing-evaluation');
    expect(
      acceptEvaluatedPlan(
        store,
        command('missing', missing),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EVALUATION_RECEIPT_MISSING',
    });

    const running = claimTask(store, snapshot(repo), 'JUNIOR', 'runner', task.id, task.revision);
    const completed = reportResult(store, 'JUNIOR', 'runner', {
      task_id: running.id,
      revision: running.revision,
      outcome: 'completed',
      result: implResult,
    });
    const executed: C2CMessage = {
      protocol_version: 'engineering-c2c/1',
      message_id: 'executed-eval',
      task_id: completed.id,
      sender_role: 'OWNER',
      state: 'EXECUTED',
      expected_revision: completed.revision,
    };
    expect(
      durableEvaluateC2CMessage(store, executed, owner(repo)).decision,
    ).toBe('READY_FOR_REVIEW');

    expect(
      acceptEvaluatedPlan(
        store,
        command('accept-executed', { ...executed, state: 'PLAN' }),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EVALUATION_MESSAGE_CONFLICT',
    });
  });

  it('replays historical acceptance after task state changes but still checks current trusted admission', () => {
    const { repo, store, task } = setup();
    const message = evaluatePlan(store, repo, task, 'replay-plan');
    const cmd = command('replay-command', message);
    const accepted = acceptEvaluatedPlan(store, cmd, owner(repo));
    expect(accepted.decision).toBe('ACCEPTED');

    cancelTask(store, task.id, task.revision);

    expect(
      acceptEvaluatedPlan(store, cmd, owner(repo)),
    ).toEqual({
      decision: 'NOOP_WITH_EXISTING_ACCEPTANCE',
      receipt: accepted.decision === 'ACCEPTED' ? accepted.receipt : undefined,
    });

    expect(
      acceptEvaluatedPlan(
        store,
        cmd,
        { actor_role: 'OWNER', repo_root: repo + '-other' },
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REPOSITORY_MISMATCH',
    });
  });

  it('detects command conflicts and allows only one command per evaluation', () => {
    const { repo, store, task } = setup();
    const planA = evaluatePlan(store, repo, task, 'plan-a');
    const planB = evaluatePlan(store, repo, task, 'plan-b');

    expect(
      acceptEvaluatedPlan(
        store,
        command('shared-command', planA),
        owner(repo),
      ).decision,
    ).toBe('ACCEPTED');

    expect(
      acceptEvaluatedPlan(
        store,
        command('shared-command', planB),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'COMMAND_ID_CONFLICT',
    });

    expect(
      acceptEvaluatedPlan(
        store,
        command('second-command', planA),
        owner(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'PLAN_ALREADY_ACCEPTED',
    });
  });

  it('has crash-safe insert/commit semantics', () => {
    const { repo, store, task } = setup();
    const message = evaluatePlan(store, repo, task, 'crash-plan');
    const dbPath = store.path;
    closeTracked(store);

    for (const [stage, code, durable] of [
      ['after_validation', 91, false],
      ['after_insert', 92, false],
      ['after_commit', 93, true],
    ] as const) {
      const cmd = command('cmd-' + stage, message);
      const child = childRun(dbPath, repo, cmd, owner(repo), stage);
      expect(child.status, child.stderr).toBe(code);

      const verify = Store.open(dbPath, { repoRoot: repo });
      stores.push(verify);
      expect(Boolean(verify.getPlanAcceptanceReceipt(cmd.command_id))).toBe(durable);
      closeTracked(verify);
    }
  });

  it('serializes concurrent duplicate acceptance into one row and replays the rest', async () => {
    const { repo, store, task } = setup();
    const message = evaluatePlan(store, repo, task, 'concurrent-plan');
    const cmd = command('concurrent-command', message);
    const dbPath = store.path;
    closeTracked(store);

    const results = await Promise.all([
      childAccept(dbPath, repo, cmd, owner(repo)),
      childAccept(dbPath, repo, cmd, owner(repo)),
      childAccept(dbPath, repo, cmd, owner(repo)),
    ]);
    expect(results.filter((item) => item.decision === 'ACCEPTED')).toHaveLength(1);
    expect(
      results.filter((item) => item.decision === 'NOOP_WITH_EXISTING_ACCEPTANCE'),
    ).toHaveLength(2);
  });
});
