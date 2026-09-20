import { describe, expect, it } from 'vitest';
import { evaluateC2CMessage } from '../src/c2c/mapping.ts';
import {
  C2C_PROTOCOL_VERSION,
  MAX_C2C_MESSAGE_BYTES,
  type AuthoritativeSnapshot,
  type C2CMessage,
  type TrustedActorContext,
} from '../src/c2c/schema.ts';
import { TASK_STATUSES } from '../src/types.ts';
import { implResult } from './helpers.ts';

function message(overrides: Partial<C2CMessage> = {}): C2CMessage {
  return {
    protocol_version: C2C_PROTOCOL_VERSION,
    message_id: 'message-1',
    task_id: 'task-1',
    sender_role: 'JUNIOR',
    state: 'PLAN',
    expected_revision: 3,
    goal: 'Implement the requested change',
    ...overrides,
  };
}

function context(overrides: Partial<TrustedActorContext> = {}): TrustedActorContext {
  return {
    actor_role: 'JUNIOR',
    repo_root: 'C:\\repo',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<AuthoritativeSnapshot> = {},
): AuthoritativeSnapshot {
  const base: AuthoritativeSnapshot = {
    task: {
      id: 'task-1',
      type: 'IMPLEMENTATION',
      status: 'READY',
      revision: 3,
      repo_root: 'C:\\repo',
      assignee_role: null,
      execution_instance_id: null,
      result: null,
    },
  };

  return {
    ...base,
    ...overrides,
    task: {
      ...base.task,
      ...(overrides.task ?? {}),
    },
  };
}

function completedSnapshot(
  overrides: Partial<AuthoritativeSnapshot> = {},
): AuthoritativeSnapshot {
  return snapshot({
    ...overrides,
    task: {
      id: 'task-1',
      type: 'IMPLEMENTATION',
      status: 'COMPLETED',
      revision: 3,
      repo_root: 'C:\\repo',
      assignee_role: 'JUNIOR',
      execution_instance_id: null,
      result: implResult,
      ...(overrides.task ?? {}),
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe('Engineering C2C S1 contract and dry-run mapping', () => {
  it('rejects malformed or unsupported protocol versions', () => {
    const wrong = evaluateC2CMessage(
      { ...message(), protocol_version: 'engineering-c2c/999' },
      context(),
      snapshot(),
    );
    expect(wrong).toMatchObject({
      decision: 'REJECT',
      code: 'INVALID_PROTOCOL_VERSION',
    });

    const missing = { ...message() } as Record<string, unknown>;
    delete missing.protocol_version;
    expect(evaluateC2CMessage(missing, context(), snapshot())).toMatchObject({
      decision: 'REJECT',
      code: 'INVALID_MESSAGE',
    });
  });

  it('rejects oversized messages before normal schema validation', () => {
    const oversized = {
      ...message(),
      rationale: 'x'.repeat(MAX_C2C_MESSAGE_BYTES + 1),
    };
    expect(evaluateC2CMessage(oversized, context(), snapshot())).toMatchObject({
      decision: 'REJECT',
      code: 'MESSAGE_TOO_LARGE',
    });
  });

  it('rejects unknown and deferred wire fields including execution_id', () => {
    for (const extra of [
      { cwd: 'C:\\other' },
      { execution_id: 'wire-execution' },
      { workspace_id: 'workspace-1' },
      { actions: [{ command: 'do-something' }] },
    ]) {
      expect(
        evaluateC2CMessage({ ...message(), ...extra }, context(), snapshot()),
      ).toMatchObject({
        decision: 'REJECT',
        code: 'INVALID_MESSAGE',
      });
    }
  });

  it('rejects a forged sender_role and never treats it as authority', () => {
    expect(
      evaluateC2CMessage(
        message({ sender_role: 'PRINCIPAL' }),
        context({ actor_role: 'JUNIOR' }),
        snapshot(),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'SENDER_ROLE_MISMATCH',
    });
  });

  it('rejects stale expected_revision', () => {
    expect(
      evaluateC2CMessage(
        message({ expected_revision: 2 }),
        context(),
        snapshot(),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REVISION_MISMATCH',
    });
  });

  it('rejects wrong trusted repository and wrong task binding', () => {
    expect(
      evaluateC2CMessage(message(), context({ repo_root: 'C:\\other' }), snapshot()),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'REPOSITORY_MISMATCH',
    });

    expect(
      evaluateC2CMessage(message({ task_id: 'other-task' }), context(), snapshot()),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'TASK_MISMATCH',
    });
  });

  it('keeps PLAN advisory and cannot authorize execution', () => {
    const result = evaluateC2CMessage(message({ state: 'PLAN' }), context(), snapshot());
    expect(result.decision).toBe('REQUIRES_OWNER_ACTION');
    expect(result).not.toHaveProperty('task');
    expect(result).not.toHaveProperty('dispatch');
    expect(result).not.toHaveProperty('status');
  });

  it('rejects EXECUTED before the Engineering lifecycle has accepted a result', () => {
    const running = snapshot({
      task: {
        id: 'task-1',
        type: 'IMPLEMENTATION',
        status: 'RUNNING',
        revision: 3,
        repo_root: 'C:\\repo',
        assignee_role: 'JUNIOR',
        execution_instance_id: 'live-runner',
        result: null,
      },
    });

    expect(
      evaluateC2CMessage(message({ state: 'EXECUTED' }), context(), running),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTED_RESULT_NOT_ACCEPTED',
    });
  });

  it('accepts EXECUTED only as a review-ready notification after authoritative completion', () => {
    const terminal = completedSnapshot();
    expect(terminal.task.execution_instance_id).toBeNull();

    const result = evaluateC2CMessage(
      message({ state: 'EXECUTED' }),
      context(),
      terminal,
    );

    expect(result.decision).toBe('READY_FOR_REVIEW');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('task');
  });

  it('does not require a dispatch for a directly accepted report_result completion', () => {
    const result = evaluateC2CMessage(
      message({ state: 'EXECUTED' }),
      context(),
      completedSnapshot(),
    );
    expect(result.decision).toBe('READY_FOR_REVIEW');
  });

  it('validates authoritative dispatch and runner provenance when requested', () => {
    const authoritative = completedSnapshot({
      dispatch: {
        id: 'dispatch-1',
        task_id: 'task-1',
        worker_role: 'JUNIOR',
        runner_instance_id: 'runner-1',
        status: 'completed',
      },
    });

    expect(
      evaluateC2CMessage(
        message({ state: 'EXECUTED' }),
        context({ dispatch_run_id: 'dispatch-1', runner_instance_id: 'runner-1' }),
        authoritative,
      ).decision,
    ).toBe('READY_FOR_REVIEW');

    expect(
      evaluateC2CMessage(
        message({ state: 'EXECUTED' }),
        context({ dispatch_run_id: 'dispatch-other' }),
        authoritative,
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTION_PROVENANCE_MISMATCH',
    });

    expect(
      evaluateC2CMessage(
        message({ state: 'EXECUTED' }),
        context({ runner_instance_id: 'runner-other' }),
        authoritative,
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTION_PROVENANCE_MISMATCH',
    });
  });

  it('rejects requested provenance when no authoritative dispatch is available', () => {
    expect(
      evaluateC2CMessage(
        message({ state: 'EXECUTED' }),
        context({ dispatch_run_id: 'dispatch-1' }),
        completedSnapshot(),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'EXECUTION_PROVENANCE_MISSING',
    });
  });

  it('rejects a non-terminal or runner-less authoritative dispatch for EXECUTED', () => {
    for (const dispatch of [
      {
        id: 'dispatch-1',
        task_id: 'task-1',
        worker_role: 'JUNIOR' as const,
        runner_instance_id: 'runner-1',
        status: 'running' as const,
      },
      {
        id: 'dispatch-1',
        task_id: 'task-1',
        worker_role: 'JUNIOR' as const,
        runner_instance_id: null,
        status: 'completed' as const,
      },
    ]) {
      const result = evaluateC2CMessage(
        message({ state: 'EXECUTED' }),
        context(),
        completedSnapshot({ dispatch }),
      );
      expect(result.decision).toBe('REJECT');
      expect(
        result.decision === 'REJECT' &&
          ['EXECUTION_PROVENANCE_MISMATCH', 'EXECUTION_PROVENANCE_MISSING'].includes(
            result.code,
          ),
      ).toBe(true);
    }
  });

  it('keeps DONE behind OWNER action and never invents CLOSED', () => {
    const result = evaluateC2CMessage(
      message({ state: 'DONE' }),
      context(),
      completedSnapshot(),
    );
    expect(result.decision).toBe('REQUIRES_OWNER_ACTION');
    expect(JSON.stringify(result)).not.toContain('CLOSED');
  });

  it('does not assume COMPLETED is permanently terminal', () => {
    const result = evaluateC2CMessage(
      message({ state: 'DONE' }),
      context(),
      completedSnapshot(),
    );
    expect(result.decision).toBe('REQUIRES_OWNER_ACTION');
    expect(result).not.toHaveProperty('next_status');
  });

  it('recognizes exact duplicate identity before stale revision rejection', () => {
    const originalMessage = message({ state: 'PLAN' });
    const first = evaluateC2CMessage(originalMessage, context(), snapshot());
    expect(first.decision).toBe('REQUIRES_OWNER_ACTION');
    if (first.decision !== 'REQUIRES_OWNER_ACTION') {
      throw new Error('expected initial receipt');
    }

    const advanced = snapshot({
      task: {
        ...snapshot().task,
        revision: 4,
      },
      existing_receipt: first.receipt,
    });

    const replay = evaluateC2CMessage(originalMessage, context(), advanced);
    expect(replay).toEqual({
      decision: 'NOOP_WITH_EXISTING_RECEIPT',
      receipt: first.receipt,
    });
  });

  it('rejects reuse of message_id with different content', () => {
    const original = message({ state: 'PLAN' });
    const first = evaluateC2CMessage(original, context(), snapshot());
    if (first.decision !== 'REQUIRES_OWNER_ACTION') {
      throw new Error('expected initial receipt');
    }

    expect(
      evaluateC2CMessage(
        { ...original, rationale: 'different content' },
        context(),
        snapshot({ existing_receipt: first.receipt }),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'MESSAGE_ID_CONFLICT',
    });
  });

  it('rejects a same-id receipt bound to a different task', () => {
    const first = evaluateC2CMessage(message(), context(), snapshot());
    if (first.decision !== 'REQUIRES_OWNER_ACTION') {
      throw new Error('expected initial receipt');
    }

    expect(
      evaluateC2CMessage(
        message(),
        context(),
        snapshot({
          existing_receipt: {
            ...first.receipt,
            task_id: 'other-task',
          },
        }),
      ),
    ).toMatchObject({
      decision: 'REJECT',
      code: 'RECEIPT_TASK_MISMATCH',
    });
  });

  it('returns C2C decisions rather than lifecycle TaskStatus values', () => {
    for (const state of ['INIT', 'PLAN', 'BLOCKED', 'ERROR'] as const) {
      const inputMessage =
        state === 'ERROR'
          ? message({ state, error: 'worker-side protocol error' })
          : message({ state });
      const result = evaluateC2CMessage(inputMessage, context(), snapshot());
      expect(result.decision).toBe('REQUIRES_OWNER_ACTION');
      expect((TASK_STATUSES as readonly string[])).not.toContain(result.decision);
    }
  });

  it('is deterministic and does not mutate message, context, or snapshot', () => {
    const inputMessage = deepFreeze(message({ rationale: 'stable input' }));
    const inputContext = deepFreeze(context());
    const inputSnapshot = deepFreeze(snapshot());

    const before = JSON.stringify({
      message: inputMessage,
      context: inputContext,
      snapshot: inputSnapshot,
    });

    const first = evaluateC2CMessage(inputMessage, inputContext, inputSnapshot);
    const second = evaluateC2CMessage(inputMessage, inputContext, inputSnapshot);

    expect(second).toEqual(first);
    expect(
      JSON.stringify({
        message: inputMessage,
        context: inputContext,
        snapshot: inputSnapshot,
      }),
    ).toBe(before);
  });
});
