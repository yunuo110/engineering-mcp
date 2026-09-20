import { bindExecution, type BoundExecution, type ExecutionBinding } from './binding.ts';
import type {
  EvidenceProjectionResult,
  EvidenceResult,
  EvidenceValidationEntry,
  ExecutionOutputProjection,
  ExecutionSummaryProjection,
  TestStatusEntryProjection,
  TestStatusProjection,
} from './schema.ts';
import type { Blocker, DispatchRun, TaskResult } from '../types.ts';

type ValidationEntry = EvidenceValidationEntry;

function rejected<T>(binding: Extract<ExecutionBinding, { kind: 'REJECT' }>): EvidenceProjectionResult<T> {
  return { ok: false, error: binding.error };
}

function processProjection(dispatch: DispatchRun | undefined): ExecutionSummaryProjection['process'] {
  if (!dispatch) {
    return {
      status: null,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_code: null,
      error_detail: null,
      verification: 'UNAVAILABLE',
    };
  }

  return {
    status: dispatch.status,
    started_at: dispatch.started_at,
    finished_at: dispatch.finished_at,
    exit_code: dispatch.exit_code,
    error_code: dispatch.error_code,
    error_detail: dispatch.error_detail,
    verification: 'VERIFIED',
  };
}
function executionIdentity(binding: Exclude<ExecutionBinding, { kind: 'REJECT' }>): {
  execution_instance_id: string | null;
  dispatch_run_id: string | null;
  adapter_id: string | null;
  worker_profile_id: string | null;
} {
  const dispatch = binding.dispatch;
  const executionInstanceId =
    binding.kind === 'BOUND_TERMINAL_EXECUTION'
      ? binding.executionInstanceId
      : binding.kind === 'UNAVAILABLE'
        ? binding.executionInstanceId
        : null;

  return {
    execution_instance_id: executionInstanceId,
    dispatch_run_id: dispatch?.id ?? null,
    adapter_id: dispatch?.adapter_id ?? null,
    worker_profile_id: dispatch?.worker_profile_id ?? null,
  };
}

function reportedSummary(binding: BoundExecution): ExecutionSummaryProjection['reported_summary'] {
  if (binding.terminal.kind === 'RESULT') {
    if ('summary' in binding.terminal.result) {
      return {
        value: binding.terminal.result.summary,
        verification: 'REPORTED',
      };
    }

    return { value: null, verification: 'UNAVAILABLE' };
  }

  if (binding.terminal.event.actor_role === 'OWNER') {
    return { value: null, verification: 'UNAVAILABLE' };
  }

  return {
    value: binding.terminal.blocker.summary,
    verification: 'REPORTED',
  };
}

export function executionSummary(
  rawSnapshot: unknown,
  rawSelector: unknown,
): EvidenceProjectionResult<ExecutionSummaryProjection> {
  const binding = bindExecution(rawSnapshot, rawSelector);
  if (binding.kind === 'REJECT') return rejected(binding);

  if (binding.kind === 'DISPATCH_FAILED_BEFORE_CLAIM') {
    return {
      ok: true,
      value: {
        task_id: binding.snapshot.task.id,
        task_type: binding.snapshot.task.type,
        repo_root: binding.snapshot.task.repo_root,
        execution: executionIdentity(binding),
        lifecycle: {
          claim_revision: null,
          terminal_revision: null,
          actor_role: null,
          outcome: 'NOT_CLAIMED',
          verification: 'UNAVAILABLE',
        },
        process: processProjection(binding.dispatch),
        reported_summary: {
          value: null,
          verification: 'UNAVAILABLE',
        },
        review_snapshot: null,
      },
    };
  }

  if (binding.kind === 'UNAVAILABLE') {
    return {
      ok: true,
      value: {
        task_id: binding.snapshot.task.id,
        task_type: binding.snapshot.task.type,
        repo_root: binding.snapshot.task.repo_root,
        execution: executionIdentity(binding),
        lifecycle: {
          claim_revision: binding.claimEvent?.revision ?? null,
          terminal_revision: null,
          actor_role: binding.claimEvent?.actor_role ?? null,
          outcome: binding.claimEvent ? 'RUNNING' : 'NOT_CLAIMED',
          verification: binding.claimEvent ? 'VERIFIED' : 'UNAVAILABLE',
        },
        process: processProjection(binding.dispatch),
        reported_summary: {
          value: null,
          verification: 'UNAVAILABLE',
        },
        review_snapshot: null,
      },
    };
  }

  const outcome =
    binding.terminal.kind === 'BLOCKER'
      ? 'BLOCKED'
      : binding.terminal.outcome === 'completed'
        ? 'COMPLETED'
        : 'FAILED';

  return {
    ok: true,
    value: {
      task_id: binding.snapshot.task.id,
      task_type: binding.snapshot.task.type,
      repo_root: binding.snapshot.task.repo_root,
      execution: executionIdentity(binding),
      lifecycle: {
        claim_revision: binding.claimEvent.revision,
        terminal_revision: binding.terminal.event.revision,
        actor_role: binding.terminal.event.actor_role,
        outcome,
        verification: 'VERIFIED',
      },
      process: processProjection(binding.dispatch),
      reported_summary: reportedSummary(binding),
      review_snapshot: binding.reviewSnapshot,
    },
  };
}

function validationForTerminal(binding: BoundExecution): ValidationEntry[] {
  const terminal: TaskResult | Blocker =
    binding.terminal.kind === 'RESULT'
      ? binding.terminal.result
      : binding.terminal.blocker;

  const reported = terminal.evidence?.worker_reported?.validation;
  if (reported !== undefined) return reported;

  return terminal.validation ?? [];
}

function resultForStatus(status: 'passed' | 'failed' | 'not_run'): Exclude<EvidenceResult, 'UNKNOWN'> {
  if (status === 'passed') return 'PASSED';
  if (status === 'failed') return 'FAILED';
  return 'NOT_RUN';
}

function overallResult(entries: TestStatusEntryProjection[]): TestStatusProjection['overall'] {
  if (entries.length === 0) {
    return { result: 'UNKNOWN', verification: 'UNAVAILABLE' };
  }

  if (entries.some((entry) => entry.result === 'FAILED')) {
    return { result: 'FAILED', verification: 'REPORTED' };
  }

  if (entries.every((entry) => entry.result === 'PASSED')) {
    return { result: 'PASSED', verification: 'REPORTED' };
  }

  if (entries.every((entry) => entry.result === 'NOT_RUN')) {
    return { result: 'NOT_RUN', verification: 'REPORTED' };
  }

  return { result: 'UNKNOWN', verification: 'REPORTED' };
}

export function testStatus(
  rawSnapshot: unknown,
  rawSelector: unknown,
): EvidenceProjectionResult<TestStatusProjection> {
  const binding = bindExecution(rawSnapshot, rawSelector);
  if (binding.kind === 'REJECT') return rejected(binding);

  const dispatchRunId = binding.dispatch?.id ?? null;
  const executionInstanceId =
    binding.kind === 'BOUND_TERMINAL_EXECUTION'
      ? binding.executionInstanceId
      : binding.kind === 'UNAVAILABLE'
        ? binding.executionInstanceId
        : null;

  if (binding.kind !== 'BOUND_TERMINAL_EXECUTION') {
    return {
      ok: true,
      value: {
        task_id: binding.snapshot.task.id,
        execution_instance_id: executionInstanceId,
        dispatch_run_id: dispatchRunId,
        entries: [],
        overall: { result: 'UNKNOWN', verification: 'UNAVAILABLE' },
      },
    };
  }

  const entries: TestStatusEntryProjection[] = validationForTerminal(binding).map((entry) => ({
    ...(entry.check === undefined ? {} : { check: entry.check }),
    ...(entry.command === undefined ? {} : { command: entry.command }),
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    ...(entry.counts === undefined ? {} : { counts: entry.counts }),
    result: resultForStatus(entry.status),
    verification: 'REPORTED',
  }));

  return {
    ok: true,
    value: {
      task_id: binding.snapshot.task.id,
      execution_instance_id: binding.executionInstanceId,
      dispatch_run_id: dispatchRunId,
      entries,
      overall: overallResult(entries),
    },
  };
}

function terminalEvidence(
  binding: BoundExecution,
): {
  persisted: TaskResult | Blocker;
  workerReported: Record<string, unknown> | null;
  runnerObserved: Record<string, unknown> | null;
  serverAuthoritative: Record<string, unknown> | null;
} {
  const persisted =
    binding.terminal.kind === 'RESULT'
      ? binding.terminal.result
      : binding.terminal.blocker;

  return {
    persisted,
    workerReported:
      (persisted.evidence?.worker_reported as Record<string, unknown> | undefined) ?? null,
    runnerObserved:
      (persisted.evidence?.runner_observed as Record<string, unknown> | undefined) ?? null,
    serverAuthoritative:
      (persisted.evidence?.server_authoritative as Record<string, unknown> | undefined) ?? null,
  };
}

function unavailableOutput(
  binding: Exclude<ExecutionBinding, { kind: 'REJECT' | 'BOUND_TERMINAL_EXECUTION' }>,
): ExecutionOutputProjection {
  return {
    task_id: binding.snapshot.task.id,
    execution_instance_id:
      binding.kind === 'UNAVAILABLE' ? binding.executionInstanceId : null,
    dispatch_run_id: binding.dispatch?.id ?? null,
    availability: 'UNAVAILABLE',
    terminal_kind: null,
    terminal_revision: null,
    persisted_terminal: null,
    worker_reported: {
      verification: 'UNAVAILABLE',
      value: null,
    },
    runner_observed: {
      verification: 'UNAVAILABLE',
      value: null,
    },
    server_authoritative: {
      verification: 'UNAVAILABLE',
      value: null,
    },
    dispatch: {
      verification: binding.dispatch ? 'VERIFIED' : 'UNAVAILABLE',
      value: binding.dispatch ?? null,
    },
    review_snapshot: null,
    raw_streams: {
      stdout: 'UNAVAILABLE',
      stderr: 'UNAVAILABLE',
    },
  };
}

export function executionOutput(
  rawSnapshot: unknown,
  rawSelector: unknown,
): EvidenceProjectionResult<ExecutionOutputProjection> {
  const binding = bindExecution(rawSnapshot, rawSelector);
  if (binding.kind === 'REJECT') return rejected(binding);

  if (binding.kind !== 'BOUND_TERMINAL_EXECUTION') {
    return { ok: true, value: unavailableOutput(binding) };
  }

  const evidence = terminalEvidence(binding);
  return {
    ok: true,
    value: {
      task_id: binding.snapshot.task.id,
      execution_instance_id: binding.executionInstanceId,
      dispatch_run_id: binding.dispatch?.id ?? null,
      availability: 'AVAILABLE',
      terminal_kind: binding.terminal.kind,
      terminal_revision: binding.terminal.event.revision,
      persisted_terminal: evidence.persisted,
      worker_reported: {
        verification: evidence.workerReported ? 'REPORTED' : 'UNAVAILABLE',
        value: evidence.workerReported,
      },
      runner_observed: {
        verification: evidence.runnerObserved ? 'VERIFIED' : 'UNAVAILABLE',
        value: evidence.runnerObserved,
      },
      server_authoritative: {
        verification: evidence.serverAuthoritative ? 'VERIFIED' : 'UNAVAILABLE',
        value: evidence.serverAuthoritative,
      },
      dispatch: {
        verification: binding.dispatch ? 'VERIFIED' : 'UNAVAILABLE',
        value: binding.dispatch ?? null,
      },
      review_snapshot: binding.reviewSnapshot,
      raw_streams: {
        stdout: 'UNAVAILABLE',
        stderr: 'UNAVAILABLE',
      },
    },
  };
}
