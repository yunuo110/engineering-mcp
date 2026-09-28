import { describe, expect, it } from 'vitest';
import { bindExecution } from '../src/evidence/binding.ts';
import {
  executionOutput,
  executionSummary,
  testStatus,
} from '../src/evidence/projection.ts';
import type {
  ExecutionEvidenceSnapshot,
  ExecutionSelector,
} from '../src/evidence/schema.ts';
import type {
  Blocker,
  DispatchRun,
  TaskCheckpoint,
  TaskContract,
  TaskEvent,
  TaskResult,
} from '../src/types.ts';
import {
  diagnosisPayload,
  diagnosisResult,
  implPayload,
  implResult,
} from './helpers.ts';

const REPO = 'C:\\repo';
const BASE = 'aaa111';
const BRANCH = 'main';
const START = '2026-09-18T00:00:00.000Z';

function authoritative(
  producerRevision: number,
  actorRole: 'JUNIOR' | 'PRINCIPAL' = 'JUNIOR',
  taskType: 'IMPLEMENTATION' | 'DIAGNOSIS' = 'IMPLEMENTATION',
) {
  return {
    task_id: 'task-1',
    task_type: taskType,
    producer_revision: producerRevision,
    actor_role: actorRole,
    repo_root: REPO,
    base_commit: BASE,
    branch: BRANCH,
  } as const;
}

function implementationResult(
  summary: string,
  producerRevision: number,
  validation: Array<{
    check?: string;
    command?: string;
    status: 'passed' | 'failed' | 'not_run';
    summary?: string;
  }> = [],
): TaskResult {
  return {
    ...implResult,
    summary,
    changed_files: ['src/example.ts'],
    validation,
    working_tree_status: { clean: false, porcelain: ' M src/example.ts' },
    evidence: {
      worker_reported: {
        implementation_complete: true,
        changed_files: ['worker-claimed.ts'],
        validation,
        git: {
          diff_check: { command: 'git diff --check', status: 'passed' },
        },
      },
      runner_observed: {
        changed_files: ['src/example.ts'],
        git: {
          head: BASE,
          branch: BRANCH,
          working_tree_status: {
            clean: false,
            porcelain: ' M src/example.ts',
          },
        },
        scope: {
          status: 'passed',
          rejected_files: [],
        },
      },
      server_authoritative: authoritative(producerRevision),
    },
  };
}

function implementationTask(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: 'task-1',
    type: 'IMPLEMENTATION',
    status: 'COMPLETED',
    owner_role: 'OWNER',
    assignee_role: 'JUNIOR',
    execution_instance_id: null,
    writer_generation: 3,
    repo_root: REPO,
    base_commit: BASE,
    branch: BRANCH,
    source_checkpoint: null,
    payload: implPayload,
    result: implementationResult('current result', 2),
    blocker: null,
    revision: 3,
    created_at: START,
    updated_at: START,
    ...overrides,
  } as TaskContract;
}

function diagnosisTask(result: TaskResult | null = diagnosisResult): TaskContract {
  return {
    id: 'task-1',
    type: 'DIAGNOSIS',
    status: 'COMPLETED',
    owner_role: 'OWNER',
    assignee_role: 'PRINCIPAL',
    execution_instance_id: null,
    writer_generation: 3,
    repo_root: REPO,
    base_commit: BASE,
    branch: BRANCH,
    source_checkpoint: null,
    payload: diagnosisPayload,
    result,
    blocker: null,
    revision: 3,
    created_at: START,
    updated_at: START,
  };
}

function claimEvent(
  executionInstanceId: string,
  revision = 2,
  id = revision,
  actorRole: 'JUNIOR' | 'PRINCIPAL' = 'JUNIOR',
): TaskEvent {
  return {
    id,
    task_id: 'task-1',
    at: `2026-09-18T00:00:0${id}.000Z`,
    actor_role: actorRole,
    kind: 'claimed',
    from_status: 'READY',
    to_status: 'RUNNING',
    revision,
    detail: { execution_instance_id: executionInstanceId },
  };
}

function resultEvent(
  executionSummaryText: string,
  producerRevision = 2,
  terminalRevision = producerRevision + 1,
  id = terminalRevision,
  validation: Parameters<typeof implementationResult>[2] = [],
): TaskEvent {
  return {
    id,
    task_id: 'task-1',
    at: `2026-09-18T00:00:1${id}.000Z`,
    actor_role: 'JUNIOR',
    kind: 'result',
    from_status: 'RUNNING',
    to_status: 'COMPLETED',
    revision: terminalRevision,
    detail: {
      outcome: 'completed',
      result: implementationResult(
        executionSummaryText,
        producerRevision,
        validation,
      ),
    },
  };
}

function diagnosisResultEvent(
  producerRevision = 2,
  terminalRevision = 3,
): TaskEvent {
  return {
    id: terminalRevision,
    task_id: 'task-1',
    at: '2026-09-18T00:00:13.000Z',
    actor_role: 'PRINCIPAL',
    kind: 'result',
    from_status: 'RUNNING',
    to_status: 'COMPLETED',
    revision: terminalRevision,
    detail: {
      outcome: 'completed',
      result: {
        ...diagnosisResult,
        evidence: {
          worker_reported: {},
          server_authoritative: authoritative(
            producerRevision,
            'PRINCIPAL',
            'DIAGNOSIS',
          ),
        },
      },
    },
  };
}

function workerBlockedEvent(
  producerRevision = 2,
  terminalRevision = 3,
): TaskEvent {
  const blocker: Blocker = {
    reason: 'TEST_FAILURE',
    summary: 'worker reported a failing test',
    need_from_owner: 'review',
    evidence_refs: [],
    validation: [
      {
        command: 'npm test',
        status: 'failed',
        summary: 'one assertion failed',
      },
    ],
    evidence: {
      worker_reported: {
        validation: [
          {
            command: 'npm test',
            status: 'failed',
            summary: 'one assertion failed',
          },
        ],
        blocker_classification: 'TEST_FAILURE',
      },
      server_authoritative: authoritative(producerRevision),
    },
  };
  return {
    id: terminalRevision,
    task_id: 'task-1',
    at: '2026-09-18T00:00:13.000Z',
    actor_role: 'JUNIOR',
    kind: 'blocked',
    from_status: 'RUNNING',
    to_status: 'BLOCKED',
    revision: terminalRevision,
    detail: { blocker },
  };
}

function dispatch(
  id: string,
  runnerInstanceId: string | null,
  status: DispatchRun['status'] = 'completed',
  overrides: Partial<DispatchRun> = {},
): DispatchRun {
  return {
    id,
    task_id: 'task-1',
    worker_role: 'JUNIOR',
    adapter_id: 'fixture-adapter',
    worker_profile_id: null,
    runner_instance_id: runnerInstanceId,
    pid: runnerInstanceId ? 1234 : null,
    status,
    started_at: runnerInstanceId ? '2026-09-18T00:00:02.000Z' : null,
    finished_at:
      status === 'launching' || status === 'running'
        ? null
        : '2026-09-18T00:00:03.000Z',
    exit_code: status === 'completed' ? 0 : status === 'failed' ? 1 : null,
    error_code: status === 'failed' ? 'WORKER_PROCESS_FAILED' : null,
    error_detail: status === 'failed' ? 'runner failed' : null,
    created_at: '2026-09-18T00:00:01.000Z',
    updated_at: '2026-09-18T00:00:03.000Z',
    ...overrides,
  };
}

function reviewCheckpoint(
  producerRevision: number,
  purpose: 'REVIEW' | 'RESUME' = 'REVIEW',
  id = `checkpoint-${purpose.toLowerCase()}`,
): TaskCheckpoint {
  return {
    id,
    task_id: 'task-1',
    producer_revision: producerRevision,
    purpose,
    state: 'FINALIZED',
    request_identity: `request-${id}`,
    repo_root: REPO,
    prior_base_commit: BASE,
    expected_tree: 'tree123',
    scope_identity: 'scope123',
    checkpoint_commit: 'bbb222',
    checkpoint_ref: `refs/engineering-mcp/checkpoints/task-1/${producerRevision}`,
    branch: BRANCH,
    changed_files: ['src/example.ts'],
    created_at: '2026-09-18T00:00:04.000Z',
    finalized_at: '2026-09-18T00:00:05.000Z',
  };
}

function snapshot(
  options: {
    task?: TaskContract;
    events?: TaskEvent[];
    dispatch?: DispatchRun;
    checkpoints?: TaskCheckpoint[];
    trustedRepoRoot?: string;
  } = {},
): ExecutionEvidenceSnapshot {
  return {
    trusted_repo_root: options.trustedRepoRoot ?? REPO,
    task: options.task ?? implementationTask(),
    task_events:
      options.events ?? [
        claimEvent('runner-a'),
        resultEvent('execution A'),
      ],
    ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  };
}

function dispatchSelector(id = 'dispatch-a'): ExecutionSelector {
  return { task_id: 'task-1', dispatch_run_id: id };
}

function directSelector(executionInstanceId = 'direct-a'): ExecutionSelector {
  return {
    task_id: 'task-1',
    execution_instance_id: executionInstanceId,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('S2 task-scoped execution evidence', () => {
  it('rejects wrong task and wrong trusted repository', () => {
    expect(
      executionSummary(
        snapshot({ dispatch: dispatch('dispatch-a', 'runner-a') }),
        { task_id: 'other-task', dispatch_run_id: 'dispatch-a' },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'TASK_MISMATCH' },
    });

    expect(
      executionSummary(
        snapshot({
          dispatch: dispatch('dispatch-a', 'runner-a'),
          trustedRepoRoot: 'C:\\other',
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'REPOSITORY_MISMATCH' },
    });
  });

  it('rejects any foreign-task task_event instead of filtering it', () => {
    const foreign: TaskEvent = {
      ...claimEvent('foreign-runner', 8, 88),
      task_id: 'other-task',
    };
    expect(
      executionSummary(
        snapshot({
          dispatch: dispatch('dispatch-a', 'runner-a'),
          events: [claimEvent('runner-a'), resultEvent('A'), foreign],
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'FOREIGN_TASK_EVENT' },
    });
  });

  it('rejects wrong dispatch and wrong runner/execution identity', () => {
    expect(
      executionSummary(
        snapshot({ dispatch: dispatch('dispatch-other', 'runner-a') }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'DISPATCH_MISMATCH' },
    });

    expect(
      executionSummary(
        snapshot({
          dispatch: dispatch('dispatch-a', 'runner-other'),
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_CLAIM_NOT_FOUND' },
    });

    expect(
      executionSummary(
        snapshot({
          dispatch: dispatch('dispatch-a', 'runner-a'),
        }),
        directSelector('runner-other'),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_PROVENANCE_MISMATCH' },
    });
  });

  it('treats a dispatch failure before claim as VERIFIED process failure only', () => {
    const preclaim = snapshot({
      task: implementationTask({
        status: 'READY',
        assignee_role: null,
        result: null,
        revision: 1,
      }),
      events: [],
      dispatch: dispatch('dispatch-a', null, 'failed'),
    });

    const summary = executionSummary(preclaim, dispatchSelector());
    expect(summary).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          claim_revision: null,
          terminal_revision: null,
          outcome: 'NOT_CLAIMED',
          verification: 'UNAVAILABLE',
        },
        process: {
          status: 'failed',
          exit_code: 1,
          verification: 'VERIFIED',
        },
      },
    });

    expect(testStatus(preclaim, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        entries: [],
        overall: {
          result: 'UNKNOWN',
          verification: 'UNAVAILABLE',
        },
      },
    });

    expect(executionOutput(preclaim, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        availability: 'UNAVAILABLE',
        terminal_kind: null,
        persisted_terminal: null,
        dispatch: { verification: 'VERIFIED' },
        raw_streams: {
          stdout: 'UNAVAILABLE',
          stderr: 'UNAVAILABLE',
        },
      },
    });
  });

  it('fails closed if a claimed execution cannot be proven by a claimed event', () => {
    expect(
      executionSummary(
        snapshot({
          events: [],
          dispatch: dispatch('dispatch-a', 'runner-a', 'failed'),
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_CLAIM_NOT_FOUND' },
    });
  });

  it('uses one binder so a selected dispatch cannot cross-wire two executions of the same task', () => {
    const resultA = resultEvent('execution A', 2, 3, 3, [
      { command: 'test A', status: 'passed' },
    ]);
    const resultB = resultEvent('execution B', 5, 6, 6, [
      { command: 'test B', status: 'failed' },
    ]);
    const currentB = implementationResult('execution B', 5, [
      { command: 'test B', status: 'failed' },
    ]);

    const multi = snapshot({
      task: implementationTask({
        revision: 6,
        result: currentB,
      }),
      events: [
        claimEvent('runner-a', 2, 2),
        resultA,
        claimEvent('runner-b', 5, 5),
        resultB,
      ],
      dispatch: dispatch('dispatch-a', 'runner-a'),
    });

    const summary = executionSummary(multi, dispatchSelector());
    expect(summary).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          claim_revision: 2,
          terminal_revision: 3,
          outcome: 'COMPLETED',
        },
        reported_summary: {
          value: 'execution A',
          verification: 'REPORTED',
        },
      },
    });

    const tests = testStatus(multi, dispatchSelector());
    expect(tests).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            command: 'test A',
            result: 'PASSED',
            verification: 'REPORTED',
          },
        ],
      },
    });

    const output = executionOutput(multi, dispatchSelector());
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(
        (output.value.persisted_terminal as { summary?: string } | null)?.summary,
      ).toBe('execution A');
    }
  });

  it('rejects ambiguous repeated use of one execution_instance_id for the same task', () => {
    expect(
      bindExecution(
        snapshot({
          events: [
            claimEvent('same-process', 2, 2),
            resultEvent('first', 2, 3, 3),
            claimEvent('same-process', 5, 5),
            resultEvent('second', 5, 6, 6),
          ],
        }),
        directSelector('same-process'),
      ),
    ).toMatchObject({
      kind: 'REJECT',
      error: { code: 'AMBIGUOUS_EXECUTION_CLAIM' },
    });
  });

  it('projects historical result after resume clears current task.result', () => {
    const resumed = implementationTask({
      status: 'READY',
      assignee_role: null,
      result: null,
      blocker: null,
      revision: 4,
    });
    const history = snapshot({
      task: resumed,
      events: [
        claimEvent('runner-a', 2, 2),
        resultEvent('historical A', 2, 3, 3),
        {
          id: 4,
          task_id: 'task-1',
          at: '2026-09-18T00:00:14.000Z',
          actor_role: 'OWNER',
          kind: 'resumed',
          from_status: 'COMPLETED',
          to_status: 'READY',
          revision: 4,
          detail: {
            previous_status: 'COMPLETED',
            previous_result: implementationResult('historical A', 2),
            previous_blocker: null,
            previous_base_commit: BASE,
            previous_payload: implPayload,
            new_base_commit: BASE,
          },
        },
      ],
      dispatch: dispatch('dispatch-a', 'runner-a'),
    });

    expect(executionOutput(history, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        availability: 'AVAILABLE',
        terminal_kind: 'RESULT',
        terminal_revision: 3,
      },
    });
  });

  it('rejects terminal revision mismatch for a terminal dispatch', () => {
    expect(
      executionSummary(
        snapshot({
          events: [
            claimEvent('runner-a', 2, 2),
            resultEvent('late', 2, 4, 4),
          ],
          dispatch: dispatch('dispatch-a', 'runner-a'),
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'TERMINAL_PROVENANCE_MISMATCH' },
    });
  });

  it('rejects mismatched server-authoritative producer revision', () => {
    const wrong = implementationResult('wrong provenance', 99);
    const event: TaskEvent = {
      ...resultEvent('ignored'),
      detail: { outcome: 'completed', result: wrong },
    };
    expect(
      executionSummary(
        snapshot({
          events: [claimEvent('runner-a'), event],
          dispatch: dispatch('dispatch-a', 'runner-a'),
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'TERMINAL_PROVENANCE_MISMATCH' },
    });
  });

  it('maps worker validation to REPORTED without promoting it to VERIFIED', () => {
    const evidence = snapshot({
      events: [
        claimEvent('runner-a'),
        resultEvent('validation', 2, 3, 3, [
          { command: 'pass', status: 'passed' },
          { command: 'fail', status: 'failed' },
          { command: 'skip', status: 'not_run' },
        ]),
      ],
      dispatch: dispatch('dispatch-a', 'runner-a'),
    });

    const tests = testStatus(evidence, dispatchSelector());
    expect(tests).toMatchObject({
      ok: true,
      value: {
        entries: [
          { command: 'pass', result: 'PASSED', verification: 'REPORTED' },
          { command: 'fail', result: 'FAILED', verification: 'REPORTED' },
          { command: 'skip', result: 'NOT_RUN', verification: 'REPORTED' },
        ],
        overall: {
          result: 'FAILED',
          verification: 'REPORTED',
        },
      },
    });
  });

  it('returns UNKNOWN / UNAVAILABLE when no test validation exists even with exit code 0 and scope pass', () => {
    const noTests = snapshot({
      events: [
        claimEvent('runner-a'),
        resultEvent('no tests', 2, 3, 3, []),
      ],
      dispatch: dispatch('dispatch-a', 'runner-a', 'completed', {
        exit_code: 0,
      }),
    });

    expect(testStatus(noTests, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        entries: [],
        overall: {
          result: 'UNKNOWN',
          verification: 'UNAVAILABLE',
        },
      },
    });
  });

  it('keeps worker-reported and runner-observed evidence separate', () => {
    const output = executionOutput(
      snapshot({
        dispatch: dispatch('dispatch-a', 'runner-a'),
      }),
      dispatchSelector(),
    );
    expect(output).toMatchObject({
      ok: true,
      value: {
        worker_reported: {
          verification: 'REPORTED',
          value: {
            changed_files: ['worker-claimed.ts'],
          },
        },
        runner_observed: {
          verification: 'VERIFIED',
          value: {
            changed_files: ['src/example.ts'],
            scope: { status: 'passed' },
          },
        },
        server_authoritative: {
          verification: 'VERIFIED',
          value: {
            task_id: 'task-1',
            producer_revision: 2,
          },
        },
      },
    });
  });

  it('rejects malformed claimed event detail', () => {
    const malformed: TaskEvent = {
      ...claimEvent('runner-a'),
      detail: { wrong_key: 'runner-a' },
    };
    expect(
      executionSummary(
        snapshot({
          events: [malformed, resultEvent('A')],
          dispatch: dispatch('dispatch-a', 'runner-a'),
        }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_EVENT_DETAIL' },
    });
  });

  it('supports a uniquely bound direct execution without DispatchRun', () => {
    const direct = snapshot({
      events: [
        claimEvent('direct-a'),
        resultEvent('direct result'),
      ],
    });
    const summary = executionSummary(direct, directSelector());
    expect(summary).toMatchObject({
      ok: true,
      value: {
        execution: {
          execution_instance_id: 'direct-a',
          dispatch_run_id: null,
        },
        lifecycle: {
          claim_revision: 2,
          terminal_revision: 3,
          verification: 'VERIFIED',
        },
        process: {
          verification: 'UNAVAILABLE',
        },
      },
    });
  });

  it('projects worker BLOCKED validation as REPORTED', () => {
    const blocked = snapshot({
      task: implementationTask({
        status: 'BLOCKED',
        result: null,
        blocker: (workerBlockedEvent().detail as { blocker: Blocker }).blocker,
      }),
      events: [claimEvent('runner-a'), workerBlockedEvent()],
      dispatch: dispatch('dispatch-a', 'runner-a', 'blocked'),
    });

    expect(testStatus(blocked, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            command: 'npm test',
            result: 'FAILED',
            verification: 'REPORTED',
          },
        ],
        overall: {
          result: 'FAILED',
          verification: 'REPORTED',
        },
      },
    });
  });

  it('exposes only exact REVIEW checkpoint provenance and never upgrades tests', () => {
    const evidence = snapshot({
      events: [
        claimEvent('runner-a'),
        resultEvent('reviewed', 2, 3, 3, [
          { command: 'npm test', status: 'passed' },
        ]),
      ],
      dispatch: dispatch('dispatch-a', 'runner-a'),
      checkpoints: [
        reviewCheckpoint(3, 'REVIEW', 'review-3'),
        reviewCheckpoint(8, 'RESUME', 'resume-8'),
      ],
    });

    expect(executionSummary(evidence, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        review_snapshot: {
          verification: 'VERIFIED',
          checkpoint_id: 'review-3',
          producer_revision: 3,
        },
      },
    });

    expect(testStatus(evidence, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            result: 'PASSED',
            verification: 'REPORTED',
          },
        ],
      },
    });
  });

  it('does not treat a RESUME checkpoint as reviewed snapshot provenance', () => {
    const evidence = snapshot({
      dispatch: dispatch('dispatch-a', 'runner-a'),
      checkpoints: [reviewCheckpoint(3, 'RESUME', 'resume-3')],
    });

    expect(executionSummary(evidence, dispatchSelector())).toMatchObject({
      ok: true,
      value: {
        review_snapshot: null,
      },
    });
  });

  it('projects diagnosis result without inventing verified tests', () => {
    const task = diagnosisTask();
    const evidence = snapshot({
      task,
      events: [
        claimEvent('principal-a', 2, 2, 'PRINCIPAL'),
        diagnosisResultEvent(),
      ],
    });

    expect(executionSummary(evidence, directSelector('principal-a'))).toMatchObject({
      ok: true,
      value: {
        task_type: 'DIAGNOSIS',
        lifecycle: {
          outcome: 'COMPLETED',
          actor_role: 'PRINCIPAL',
        },
        reported_summary: {
          value: null,
          verification: 'UNAVAILABLE',
        },
      },
    });

    expect(executionOutput(evidence, directSelector('principal-a'))).toMatchObject({
      ok: true,
      value: {
        availability: 'AVAILABLE',
        terminal_kind: 'RESULT',
        persisted_terminal: {
          verdict: diagnosisResult.verdict,
        },
      },
    });

    expect(testStatus(evidence, directSelector('principal-a'))).toMatchObject({
      ok: true,
      value: {
        overall: {
          result: 'UNKNOWN',
          verification: 'UNAVAILABLE',
        },
      },
    });
  });

  it('never fabricates raw stdout/stderr from run-directory artifacts', () => {
    expect(
      executionOutput(
        snapshot({ dispatch: dispatch('dispatch-a', 'runner-a') }),
        dispatchSelector(),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        raw_streams: {
          stdout: 'UNAVAILABLE',
          stderr: 'UNAVAILABLE',
        },
      },
    });
  });

  it('is deterministic and does not mutate the authoritative snapshot', () => {
    const frozenSnapshot = deepFreeze(
      snapshot({ dispatch: dispatch('dispatch-a', 'runner-a') }),
    );
    const frozenSelector = deepFreeze(dispatchSelector());
    const before = JSON.stringify({ frozenSnapshot, frozenSelector });

    const first = executionOutput(frozenSnapshot, frozenSelector);
    const second = executionOutput(frozenSnapshot, frozenSelector);

    expect(second).toEqual(first);
    expect(JSON.stringify({ frozenSnapshot, frozenSelector })).toBe(before);
  });
});
