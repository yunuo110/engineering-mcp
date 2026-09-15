import type { McpServer } from '@modelcontextprotocol/server';
import { inspectRepo } from './git.ts';
import { isDomainError } from './errors.ts';
import {
  cancelTask,
  checkpointTask,
  claimNextTask,
  claimTask,
  closeTask,
  createDiagnosisFromCheckpoint,
  createTask,
  getTask,
  inspectClaimableTask,
  listActiveTasks,
  recoverTask,
  reportBlocked,
  resumeTask,
  reportResult,
} from './lifecycle.ts';
import { toolsForProcessRole } from './role.ts';
import { delegateTask, waitForDispatch } from './orchestration/dispatcher.ts';
import { listWorkerProfiles, resolveWorkerProfile, type WorkerProfiles } from './worker-profiles.ts';
import type { Store } from './store.ts';
import {
  awaitDelegationInputSchema,
  cancelTaskInputSchema,
  checkpointTaskInputSchema,
  checkpointToolOutputSchema,
  claimTicketToolOutputSchema,
  claimNextTaskInputSchema,
  claimTaskInputSchema,
  closeTaskInputSchema,
  createTaskInputSchema,
  createDiagnosisFromCheckpointInputSchema,
  delegateTaskInputSchema,
  dispatchToolOutputSchema,
  getTaskInputSchema,
  inspectClaimableTaskInputSchema,
  listActiveTasksInputSchema,
  listToolOutputSchema,
  listWorkerProfilesInputSchema,
  listWorkerProfilesOutputSchema,
  processRoleToRole,
  recoverTaskInputSchema,
  reportBlockedInputSchema,
  reportResultInputSchema,
  resumeTaskInputSchema,
  taskToolOutputSchema,
  transitionTaskToolOutputSchema,
  type GitSnapshot,
  type ProcessRole,
  type DispatchRun,
  type TaskContract,
  type TaskCheckpoint,
  type TaskStatus,
  type TransitionReceipt,
} from './types.ts';

export type ServerConfig = {
  processRole: ProcessRole;
  repoPath: string;
  store: Store;
  executionInstanceId: string;
  workerProfiles: WorkerProfiles;
};

function taskText(prefix: string, task: TaskContract): string {
  const assignee = task.assignee_role ?? 'none';
  return `${prefix} ${task.type} ${task.id} status=${task.status} rev=${task.revision} assignee=${assignee}`;
}

function transitionReceipt(
  task: TaskContract,
  previousStatus: TaskStatus | null,
  options?: { dispatch?: DispatchRun; checkpoint?: TaskCheckpoint },
): TransitionReceipt {
  const dispatch = options?.dispatch;
  return {
    task_id: task.id,
    type: task.type,
    previous_status: previousStatus,
    status: task.status,
    revision: task.revision,
    assignee_role: task.assignee_role,
    repo_root: task.repo_root,
    base_commit: task.base_commit,
    branch: task.branch,
    ...(dispatch
      ? {
          delegation: {
            dispatch_run_id: dispatch.id,
            worker_profile: dispatch.worker_profile_id,
            worker_role: dispatch.worker_role,
            adapter_id: dispatch.adapter_id,
            state: dispatch.status,
          },
        }
      : {}),
    ...(options?.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(task.source_checkpoint ? { source_checkpoint: task.source_checkpoint } : {}),
  };
}

function latestReceipt(
  store: Store,
  task: TaskContract,
  options?: { dispatch?: DispatchRun; checkpoint?: TaskCheckpoint },
): TransitionReceipt {
  const events = store.listEvents(task.id);
  const event = [...events].reverse().find((item) => item.revision === task.revision);
  const previousStatus = options?.dispatch && event?.kind === 'created'
    ? task.status
    : (event?.from_status ?? null);
  return transitionReceipt(task, previousStatus, options);
}

function okTask(prefix: string, task: TaskContract, receipt?: TransitionReceipt) {
  return {
    content: [{ type: 'text' as const, text: taskText(prefix, task) }],
    structuredContent: { ok: true as const, task, ...(receipt ? { receipt } : {}) },
  };
}

function boundedList(items: string[], limit = 12): string {
  const bounded = items.slice(0, limit);
  const suffix = items.length > limit ? `\n[truncated ${items.length - limit} more]` : '';
  return bounded.join('\n');
}

function dispatchText(run: unknown, task: TaskContract, git?: GitSnapshot, stillRunning = false): string {
  const r = run as {
    id?: string;
    status?: string;
    adapter_id?: string;
    worker_profile_id?: string | null;
    worker_role?: string;
    exit_code?: number | null;
    error_code?: string | null;
    error_detail?: string | null;
  };
  const lines: string[] = [];
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Dispatch Run ID: ${r.id ?? 'unknown'}`);
  lines.push(`Worker Profile: ${r.worker_profile_id ?? '(default)'}`);
  lines.push(`Adapter: ${r.adapter_id ?? 'unknown'}`);
  lines.push(`Worker Role: ${r.worker_role ?? 'JUNIOR'}`);
  lines.push(`Dispatch Status: ${r.status ?? 'unknown'}`);
  if (stillRunning) {
    lines.push(`DISPATCH_STILL_RUNNING: use await_delegation with Dispatch Run ID ${r.id ?? 'unknown'}`);
  }
  lines.push(`Task Status: ${task.status}`);
  lines.push(`Task Revision: ${task.revision}`);
  if (task.status === 'COMPLETED' && task.result) {
    const result = task.result as {
      summary?: string;
      changed_files?: string[];
      validation?: Array<{ check?: string; command?: string; status?: string }>;
      working_tree_status?: { clean?: boolean; porcelain?: string };
    };
    lines.push(`Outcome: completed`);
    if (result.summary) lines.push(`Summary: ${result.summary}`);
    if (result.changed_files?.length) lines.push(`Changed Files:\n${boundedList(result.changed_files)}`);
    const validation = result.validation ?? [];
    lines.push(
      `Validation: ${validation.map((v) => `${v.command ?? v.check ?? '?'}=${v.status ?? '?'}`).join(', ') || 'none'}`,
    );
  }
  if (task.status === 'BLOCKED' && task.blocker) {
    lines.push(`Outcome: blocked`);
    lines.push(`Blocker Reason: ${task.blocker.reason}`);
    lines.push(`Blocker Summary: ${task.blocker.summary}`);
  }
  if (r.error_code || r.error_detail) {
    lines.push(`Error Code: ${r.error_code ?? 'none'}`);
    lines.push(`Error Detail: ${r.error_detail ?? 'none'}`);
  }
  if (r.exit_code !== null && r.exit_code !== undefined) {
    lines.push(`Worker Exit Code: ${r.exit_code}`);
  }
  lines.push(`HEAD Before: ${task.base_commit}`);
  if (git) {
    lines.push(`HEAD After: ${git.head}`);
    lines.push(`Final Working Tree Clean: ${git.clean}`);
    if (git.porcelain) lines.push(`Final Working Tree Porcelain:\n${boundedList(git.porcelain.split('\n'))}`);
  }
  return lines.join('\n');
}

function okDispatch(
  run: DispatchRun,
  task: TaskContract,
  receipt: TransitionReceipt,
  git?: GitSnapshot,
  stillRunning = false,
) {
  return {
    content: [{ type: 'text' as const, text: dispatchText(run, task, git, stillRunning) }],
    structuredContent: {
      ok: true as const,
      dispatch_run: run,
      task,
      receipt,
      ...(stillRunning ? { still_running: true } : {}),
    },
  };
}

function fail(error: unknown) {
  if (isDomainError(error)) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `${error.code}: ${error.message}` }],
      structuredContent: {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `INTERNAL: ${message}` }],
    structuredContent: {
      ok: false as const,
      error: { code: 'INTERNAL', message },
    },
  };
}

export function registerRoleTools(server: McpServer, config: ServerConfig): void {
  const allowed = new Set(toolsForProcessRole(config.processRole));
  const actor = processRoleToRole(config.processRole);
  config.store.bindRepository(config.repoPath);

  if (allowed.has('create_task')) {
    server.registerTool(
      'create_task',
      {
        title: 'Create task',
        description: 'Create a READY implementation or diagnosis task from the current clean Git baseline.',
        inputSchema: createTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = createTask(config.store, git, args);
          return okTask('Created', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('create_diagnosis_from_checkpoint')) {
    server.registerTool(
      'create_diagnosis_from_checkpoint',
      {
        title: 'Create diagnosis from REVIEW checkpoint',
        description: 'Create a DIAGNOSIS task authoritatively bound to a finalized REVIEW checkpoint.',
        inputSchema: createDiagnosisFromCheckpointInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = createDiagnosisFromCheckpoint(config.store, git, args);
          return okTask('Created review', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('inspect_claimable_task')) {
    server.registerTool(
      'inspect_claimable_task',
      {
        title: 'Inspect claimable task',
        description:
          'Read only the minimal claim ticket for a READY task permitted for this worker role.',
        inputSchema: inspectClaimableTaskInputSchema,
        outputSchema: claimTicketToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const claimTicket = inspectClaimableTask(config.store, git, actor, args.task_id);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Claim ticket ${claimTicket.type} ${claimTicket.task_id} rev=${claimTicket.revision}`,
              },
            ],
            structuredContent: { ok: true as const, claim_ticket: claimTicket },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('get_task')) {
    server.registerTool(
      'get_task',
      {
        title: 'Get task',
        description:
          config.processRole === 'owner'
            ? 'Read any task in this repository ledger.'
            : 'Read the task currently assigned to this worker (RUNNING or BLOCKED).',
        inputSchema: getTaskInputSchema,
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const task = getTask(config.store, actor, args.task_id);
          return okTask('Task', task);
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('list_active_tasks')) {
    server.registerTool(
      'list_active_tasks',
      {
        title: 'List active tasks',
        description: 'List tasks that are not CLOSED.',
        inputSchema: listActiveTasksInputSchema,
        outputSchema: listToolOutputSchema,
      },
      (args) => {
        try {
          const tasks = listActiveTasks(config.store, args.type);
          return {
            content: [{ type: 'text' as const, text: `Active tasks: ${tasks.length}` }],
            structuredContent: { ok: true as const, tasks },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('claim_task')) {
    server.registerTool(
      'claim_task',
      {
        title: 'Claim task',
        description: 'Claim a READY task of this worker type. Returns the complete Task Contract.',
        inputSchema: claimTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = claimTask(config.store, git, actor, config.executionInstanceId, args.task_id, args.revision);
          return okTask('Claimed', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('claim_next_task')) {
    server.registerTool(
      'claim_next_task',
      {
        title: 'Claim next task',
        description:
          'Atomically claim the oldest READY task of this worker type. Returns the complete Task Contract.',
        inputSchema: claimNextTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      () => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = claimNextTask(config.store, git, actor, config.executionInstanceId);
          return okTask('Claimed', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('report_result')) {
    server.registerTool(
      'report_result',
      {
        title: 'Report result',
        description: 'Report COMPLETED or FAILED for the assigned RUNNING task.',
        inputSchema: reportResultInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const task = reportResult(config.store, actor, config.executionInstanceId, args);
          return okTask('Reported', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('report_blocked')) {
    server.registerTool(
      'report_blocked',
      {
        title: 'Report blocked',
        description: 'Report BLOCKED for the assigned RUNNING task and release the writer slot.',
        inputSchema: reportBlockedInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const task = reportBlocked(config.store, actor, config.executionInstanceId, args);
          return okTask('Blocked', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('delegate_task')) {
    server.registerTool(
      'delegate_task',
      {
        title: 'Delegate task',
        description:
          'Delegate a READY implementation task to the trusted JUNIOR Luna worker runner and wait for terminal task state.',
        inputSchema: delegateTaskInputSchema,
        outputSchema: dispatchToolOutputSchema,
      },
      async (args) => {
        try {
          const profile = resolveWorkerProfile(config.workerProfiles, args.worker_profile);
          const preGit = inspectRepo(config.repoPath);
          const run = await delegateTask(config.store, preGit, args.task_id, args.revision, {
            adapterId: profile.adapter,
            workerProfileId: profile.id,
            manifestPath: profile.manifestSnapshot ? undefined : profile.manifest,
            manifestSnapshot: profile.manifestSnapshot,
            profile: profile.profile,
            model: profile.model,
          });
          const task = config.store.getTask(args.task_id);
          if (!task) throw new Error('task disappeared during delegation');
          const postGit = inspectRepo(config.repoPath);
          const stillRunning = run.status === 'launching' || run.status === 'running';
          return okDispatch(
            run,
            task,
            latestReceipt(config.store, task, { dispatch: run }),
            postGit,
            stillRunning,
          );
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('list_worker_profiles')) {
    server.registerTool(
      'list_worker_profiles',
      {
        title: 'List worker profiles',
        description: 'List trusted worker execution profiles available to this OWNER process.',
        inputSchema: listWorkerProfilesInputSchema,
        outputSchema: listWorkerProfilesOutputSchema,
      },
      () => {
        try {
          const profiles = listWorkerProfiles(config.workerProfiles);
          const text = profiles
            .map((p) =>
              [
                p.id,
                `adapter: ${p.adapter}`,
                `default: ${p.default}`,
                ...(p.description ? [`description: ${p.description}`] : []),
              ].join('\n'),
            )
            .join('\n');
          return {
            content: [{ type: 'text' as const, text: text || 'No worker profiles' }],
            structuredContent: { ok: true as const, profiles },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('await_delegation')) {
    server.registerTool(
      'await_delegation',
      {
        title: 'Await delegation',
        description:
          'Wait for a dispatch run to reach terminal state without terminating the worker runner.',
        inputSchema: awaitDelegationInputSchema,
        outputSchema: dispatchToolOutputSchema,
      },
      async (args) => {
        try {
          const run = await waitForDispatch(config.store, args.dispatch_run_id, args.timeout ?? 120_000);
          const task = config.store.getTask(run.task_id);
          if (!task) throw new Error('task disappeared while awaiting delegation');
          const git = inspectRepo(config.repoPath);
          const stillRunning = run.status === 'launching' || run.status === 'running';
          return okDispatch(
            run,
            task,
            latestReceipt(config.store, task, { dispatch: run }),
            git,
            stillRunning,
          );
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('recover_task')) {
    server.registerTool(
      'recover_task',
      {
        title: 'Recover task',
        description:
          'OWNER-only explicit recovery: move a RUNNING task to BLOCKED and clear its execution owner.',
        inputSchema: recoverTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = recoverTask(config.store, git, args);
          return okTask('Recovered', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('checkpoint_task')) {
    server.registerTool(
      'checkpoint_task',
      {
        title: 'Checkpoint task output',
        description:
          'Record dirty implementation output as an immutable Git checkpoint before resume or review handoff.',
        inputSchema: checkpointTaskInputSchema,
        outputSchema: checkpointToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const { task, checkpoint } = checkpointTask(config.store, git, args);
          const receipt = latestReceipt(config.store, task, { checkpoint });
          return {
            content: [
              {
                type: 'text' as const,
                text: `${taskText('Checkpointed', task)} checkpoint=${checkpoint.checkpoint_commit}`,
              },
            ],
            structuredContent: { ok: true as const, task, checkpoint, receipt },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('resume_task')) {
    server.registerTool(
      'resume_task',
      {
        title: 'Resume task',
        description: 'Reopen a BLOCKED, FAILED, or COMPLETED task to READY with a fresh Git baseline.',
        inputSchema: resumeTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = resumeTask(config.store, git, args);
          return okTask('Resumed', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('cancel_task')) {
    server.registerTool(
      'cancel_task',
      {
        title: 'Cancel task',
        description: 'Cancel a non-CLOSED task.',
        inputSchema: cancelTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const task = cancelTask(config.store, args.task_id, args.revision, args.reason);
          return okTask('Cancelled', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (allowed.has('close_task')) {
    server.registerTool(
      'close_task',
      {
        title: 'Close task',
        description: 'Owner integration decision: close COMPLETED, FAILED, or CANCELLED tasks.',
        inputSchema: closeTaskInputSchema,
        outputSchema: transitionTaskToolOutputSchema,
      },
      (args) => {
        try {
          const task = closeTask(config.store, args.task_id, args.revision, args.decision);
          return okTask('Closed', task, latestReceipt(config.store, task));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }
}
