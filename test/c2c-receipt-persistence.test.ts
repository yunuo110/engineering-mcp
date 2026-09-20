import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import {
  cancelTask,
  claimTask,
  createTask,
  reportResult,
} from '../src/lifecycle.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { Store } from '../src/store.ts';
import type {
  C2CMessage,
  TrustedActorContext,
} from '../src/c2c/schema.ts';
import type { DispatchRun, TaskContract } from '../src/types.ts';
import {
  implPayload,
  implResult,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const fixture = fileURLToPath(
  new URL('./fixtures/c2c-receipt-worker.ts', import.meta.url),
);
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
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

function ownerContext(repo: string): TrustedActorContext {
  return {
    actor_role: 'OWNER',
    repo_root: repo,
  };
}

function ownerMessage(
  task: TaskContract,
  overrides: Partial<C2CMessage> = {},
): C2CMessage {
  return {
    protocol_version: 'engineering-c2c/1',
    message_id: 'message-1',
    task_id: task.id,
    sender_role: 'OWNER',
    state: 'PLAN',
    expected_revision: task.revision,
    goal: 'evaluate plan',
    ...overrides,
  };
}

function dispatch(
  taskId: string,
  id: string,
  runnerInstanceId: string | null,
  status: DispatchRun['status'],
): DispatchRun {
  const now = new Date().toISOString();
  return {
    id,
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: 'fixture-adapter',
    worker_profile_id: null,
    runner_instance_id: runnerInstanceId,
    pid: null,
    status,
    started_at: runnerInstanceId ? now : null,
    finished_at:
      status === 'completed' || status === 'blocked' || status === 'failed'
        ? now
        : null,
    exit_code: status === 'completed' ? 0 : null,
    error_code: null,
    error_detail: null,
    created_at: now,
    updated_at: now,
  };
}

function closeTracked(store: Store): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

function runFixture(
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [fixture, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function evaluateInChild(
  dbPath: string,
  repo: string,
  message: C2CMessage,
  context: TrustedActorContext,
): Promise<{ code: number | null; result?: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fixture,
        '--mode',
        'evaluate',
        '--store',
        dbPath,
        '--repo',
        repo,
        '--message',
        JSON.stringify(message),
        '--context',
        JSON.stringify(context),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
    child.on('close', (code) => {
      let result: Record<string, unknown> | undefined;
      const line = stdout
        .split(String.fromCharCode(10))
        .map((item) => item.trim())
        .find((item) => item.startsWith('{'));
      if (line) result = JSON.parse(line) as Record<string, unknown>;
      resolve({ code, result, stderr });
    });
    child.on('error', (error) => {
      resolve({ code: null, stderr: String(error) });
    });
  });
}

describe('S3A durable C2C evaluation receipts', () => {
  it('persists exactly one advisory receipt without mutating domain state', () => {
    const { repo, store, task } = setup();
    const message = ownerMessage(task);
    const before = {
      task: store.getTask(task.id),
      events: store.listEvents(task.id),
      dispatches: store.listDispatchRunsForTask(task.id),
      checkpoints: store.listCheckpoints(task.id),
    };

    const result = durableEvaluateC2CMessage(
      store,
      message,
      ownerContext(repo),
    );

    expect(result.decision).toBe('REQUIRES_OWNER_ACTION');
    if (result.decision !== 'REQUIRES_OWNER_ACTION') {
      throw new Error('expected durable advisory receipt');
    }

    const durable = store.getC2CEvaluationReceipt(message.message_id);
    expect(durable).toMatchObject({
      ...result.receipt,
      task_id: task.id,
      evaluated_revision: task.revision,
      decision: 'REQUIRES_OWNER_ACTION',
    });
    expect(durable?.created_at).toBeTypeOf('string');

    expect(store.getTask(task.id)).toEqual(before.task);
    expect(store.listEvents(task.id)).toEqual(before.events);
    expect(store.listDispatchRunsForTask(task.id)).toEqual(before.dispatches);
    expect(store.listCheckpoints(task.id)).toEqual(before.checkpoints);
  });

  it('replays the original durable receipt after response loss, reopen, and revision advance', () => {
    const { repo, store, task } = setup();
    const message = ownerMessage(task, { message_id: 'response-loss' });

    expect(() =>
      durableEvaluateC2CMessage(
        store,
        message,
        ownerContext(repo),
        {
          onStage(stage) {
            if (stage === 'after_commit') throw new Error('response lost');
          },
        },
      ),
    ).toThrow('response lost');

    const original = store.getC2CEvaluationReceipt(message.message_id);
    expect(original).toBeDefined();

    const cancelled = cancelTask(store, task.id, task.revision, 'advance state');
    expect(cancelled.revision).toBe(task.revision + 1);

    const dbPath = store.path;
    closeTracked(store);
    const reopened = Store.open(dbPath, { repoRoot: repo });
    stores.push(reopened);

    const replay = durableEvaluateC2CMessage(
      reopened,
      message,
      ownerContext(repo),
    );
    expect(replay).toEqual({
      decision: 'NOOP_WITH_EXISTING_RECEIPT',
      receipt: {
        message_id: original!.message_id,
        message_digest: original!.message_digest,
        task_id: original!.task_id,
        evaluated_revision: original!.evaluated_revision,
        decision: original!.decision,
      },
    });
    expect(reopened.getC2CEvaluationReceipt(message.message_id)).toEqual(
      original,
    );
  });

  it('detects message-id conflicts across payload, state, and task identity', () => {
    const { repo, store, task } = setup();
    const first = ownerMessage(task, {
      message_id: 'shared-id',
      rationale: 'original',
    });
    expect(
      durableEvaluateC2CMessage(store, first, ownerContext(repo)).decision,
    ).toBe('REQUIRES_OWNER_ACTION');

    expect(
      durableEvaluateC2CMessage(
        store,
        { ...first, rationale: 'changed' },
        ownerContext(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'MESSAGE_ID_CONFLICT',
    });

    expect(
      durableEvaluateC2CMessage(
        store,
        { ...first, state: 'DONE' },
        ownerContext(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'MESSAGE_ID_CONFLICT',
    });

    const other = createTask(store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    expect(
      durableEvaluateC2CMessage(
        store,
        {
          ...ownerMessage(other),
          message_id: 'shared-id',
        },
        ownerContext(repo),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'RECEIPT_TASK_MISMATCH',
    });

    expect(store.getC2CEvaluationReceipt('shared-id')).toMatchObject({
      task_id: task.id,
    });
  });

  it('does not persist stale or rejected evaluations', () => {
    const { repo, store, task } = setup();

    const stale = ownerMessage(task, {
      message_id: 'stale',
      expected_revision: task.revision + 5,
    });
    expect(
      durableEvaluateC2CMessage(store, stale, ownerContext(repo)),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REVISION_MISMATCH',
    });
    expect(store.getC2CEvaluationReceipt('stale')).toBeUndefined();

    const forged = ownerMessage(task, {
      message_id: 'forged',
      sender_role: 'JUNIOR',
    });
    expect(
      durableEvaluateC2CMessage(store, forged, ownerContext(repo)),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'SENDER_ROLE_MISMATCH',
    });
    expect(store.getC2CEvaluationReceipt('forged')).toBeUndefined();
  });

  it('checks current trusted admission before returning an exact replay', () => {
    const { repo, store, task } = setup();
    const running = claimTask(
      store,
      snapshot(repo),
      'JUNIOR',
      'worker-a',
      task.id,
      task.revision,
    );
    const message: C2CMessage = {
      protocol_version: 'engineering-c2c/1',
      message_id: 'worker-replay',
      task_id: running.id,
      sender_role: 'JUNIOR',
      state: 'PLAN',
      expected_revision: running.revision,
      goal: 'worker-side plan',
    };
    const context: TrustedActorContext = {
      actor_role: 'JUNIOR',
      repo_root: repo,
    };

    expect(
      durableEvaluateC2CMessage(store, message, context).decision,
    ).toBe('REQUIRES_OWNER_ACTION');

    expect(
      durableEvaluateC2CMessage(store, message, {
        ...context,
        repo_root: repo + '-foreign',
      }),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REPOSITORY_MISMATCH',
    });

    cancelTask(store, running.id, running.revision, 'revoke worker access');

    let accessError: unknown;
    try {
      durableEvaluateC2CMessage(store, message, context);
    } catch (error) {
      accessError = error;
    }
    expect(accessError).toBeInstanceOf(DomainError);
    expect((accessError as DomainError).code).toBe('NOT_ASSIGNED');
    expect(store.getC2CEvaluationReceipt('worker-replay')).toBeDefined();
  });

  it('materializes only exact dispatch provenance and rejects ambiguous runner identity', () => {
    const { repo, store, task } = setup();
    const initialDispatch = dispatch(
      task.id,
      'dispatch-a',
      null,
      'launching',
    );
    store.transact(() => store.insertDispatchRun(initialDispatch));

    const running = claimTask(
      store,
      snapshot(repo),
      'JUNIOR',
      'runner-a',
      task.id,
      task.revision,
      {
        ...initialDispatch,
        status: 'running',
        runner_instance_id: 'runner-a',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    );
    const currentDispatch = store.getDispatchRun('dispatch-a')!;
    const completed = reportResult(
      store,
      'JUNIOR',
      'runner-a',
      {
        task_id: running.id,
        revision: running.revision,
        outcome: 'completed',
        result: implResult,
      },
      {
        ...currentDispatch,
        status: 'completed',
        finished_at: new Date().toISOString(),
        exit_code: 0,
        updated_at: new Date().toISOString(),
      },
    );

    const executed: C2CMessage = {
      protocol_version: 'engineering-c2c/1',
      message_id: 'executed-exact',
      task_id: completed.id,
      sender_role: 'JUNIOR',
      state: 'EXECUTED',
      expected_revision: completed.revision,
      evidence_refs: [],
    };
    const exactContext: TrustedActorContext = {
      actor_role: 'JUNIOR',
      repo_root: repo,
      dispatch_run_id: 'dispatch-a',
      runner_instance_id: 'runner-a',
    };

    expect(
      durableEvaluateC2CMessage(store, executed, exactContext).decision,
    ).toBe('READY_FOR_REVIEW');

    expect(
      durableEvaluateC2CMessage(
        store,
        { ...executed, message_id: 'missing-dispatch' },
        {
          ...exactContext,
          dispatch_run_id: 'does-not-exist',
        },
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTION_PROVENANCE_MISSING',
    });
    expect(
      store.getC2CEvaluationReceipt('missing-dispatch'),
    ).toBeUndefined();

    store.transact(() =>
      store.insertDispatchRun(
        dispatch(
          task.id,
          'dispatch-b',
          'runner-a',
          'completed',
        ),
      ),
    );

    expect(
      durableEvaluateC2CMessage(
        store,
        { ...executed, message_id: 'ambiguous-runner' },
        {
          actor_role: 'JUNIOR',
          repo_root: repo,
          runner_instance_id: 'runner-a',
        },
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTION_PROVENANCE_MISMATCH',
    });
    expect(
      store.getC2CEvaluationReceipt('ambiguous-runner'),
    ).toBeUndefined();
  });

  it('rolls back evaluation and insert stages on real process death, but keeps post-commit receipt', () => {
    const { repo, store, task } = setup();
    const dbPath = store.path;
    closeTracked(store);

    const context = ownerContext(repo);
    for (const [stage, expectedCode, durable] of [
      ['after_evaluation', 81, false],
      ['after_insert', 82, false],
      ['after_commit', 83, true],
    ] as const) {
      const message = ownerMessage(task, {
        message_id: 'crash-' + stage,
      });
      const child = runFixture([
        '--mode',
        'crash',
        '--store',
        dbPath,
        '--repo',
        repo,
        '--message',
        JSON.stringify(message),
        '--context',
        JSON.stringify(context),
        '--stage',
        stage,
      ]);
      expect(child.status, child.stderr).toBe(expectedCode);

      const verify = Store.open(dbPath, { repoRoot: repo });
      stores.push(verify);
      const stored = verify.getC2CEvaluationReceipt(message.message_id);
      expect(Boolean(stored)).toBe(durable);
      if (durable) {
        expect(
          durableEvaluateC2CMessage(
            verify,
            message,
            context,
          ).decision,
        ).toBe('NOOP_WITH_EXISTING_RECEIPT');
      }
      closeTracked(verify);
    }
  });

  it('serializes concurrent identical requests into one durable receipt', async () => {
    const { repo, store, task } = setup();
    const dbPath = store.path;
    closeTracked(store);

    const message = ownerMessage(task, {
      message_id: 'concurrent-same',
    });
    const context = ownerContext(repo);
    const results = await Promise.all([
      evaluateInChild(dbPath, repo, message, context),
      evaluateInChild(dbPath, repo, message, context),
      evaluateInChild(dbPath, repo, message, context),
      evaluateInChild(dbPath, repo, message, context),
    ]);

    expect(results.every((item) => item.code === 0)).toBe(true);
    const decisions = results.map((item) => item.result?.decision);
    expect(
      decisions.filter((item) => item === 'REQUIRES_OWNER_ACTION'),
    ).toHaveLength(1);
    expect(
      decisions.filter(
        (item) => item === 'NOOP_WITH_EXISTING_RECEIPT',
      ),
    ).toHaveLength(3);

    const verify = Store.open(dbPath, { repoRoot: repo });
    stores.push(verify);
    expect(
      verify.getC2CEvaluationReceipt('concurrent-same'),
    ).toBeDefined();
  });

  it('serializes concurrent same-id different-payload requests into success plus conflict', async () => {
    const { repo, store, task } = setup();
    const dbPath = store.path;
    closeTracked(store);

    const first = ownerMessage(task, {
      message_id: 'concurrent-conflict',
      rationale: 'A',
    });
    const second = {
      ...first,
      rationale: 'B',
    };
    const context = ownerContext(repo);

    const results = await Promise.all([
      evaluateInChild(dbPath, repo, first, context),
      evaluateInChild(dbPath, repo, second, context),
    ]);
    expect(results.every((item) => item.code === 0)).toBe(true);

    const decisions = results.map((item) => item.result);
    expect(
      decisions.filter(
        (item) => item?.decision === 'REQUIRES_OWNER_ACTION',
      ),
    ).toHaveLength(1);
    expect(
      decisions.filter(
        (item) =>
          item?.decision === 'REJECT' &&
          item.code === 'MESSAGE_ID_CONFLICT',
      ),
    ).toHaveLength(1);

    const verify = Store.open(dbPath, { repoRoot: repo });
    stores.push(verify);
    const stored = verify.getC2CEvaluationReceipt(
      'concurrent-conflict',
    );
    expect(stored).toBeDefined();
  });
});
