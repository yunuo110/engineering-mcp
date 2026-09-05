import type { McpServer } from '@modelcontextprotocol/server';
import { inspectRepo } from './git.ts';
import { isDomainError } from './errors.ts';
import {
  cancelTask,
  claimNextTask,
  claimTask,
  closeTask,
  createTask,
  getTask,
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
  claimNextTaskInputSchema,
  claimTaskInputSchema,
  closeTaskInputSchema,
  createTaskInputSchema,
  delegateTaskInputSchema,
  dispatchToolOutputSchema,
  getTaskInputSchema,
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
  type GitSnapshot,
  type ProcessRole,
  type TaskContract,
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

function okTask(prefix: string, task: TaskContract) {
  return {
    content: [{ type: 'text' as const, text: taskText(prefix, task) }],
    structuredContent: { ok: true as const, task },
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
      validation?: Array<{ check?: string; status?: string }>;
      working_tree_status?: { clean?: boolean; porcelain?: string };
    };
    lines.push(`Outcome: completed`);
    if (result.summary) lines.push(`Summary: ${result.summary}`);
    if (result.changed_files?.length) lines.push(`Changed Files:\n${boundedList(result.changed_files)}`);
    const validation = result.validation ?? [];
    lines.push(`Validation: ${validation.map((v) => `${v.check ?? '?'}=${v.status ?? '?'}`).join(', ') || 'none'}`);
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

function okDispatch(run: unknown, task: TaskContract, git?: GitSnapshot, stillRunning = false) {
  return {
    content: [{ type: 'text' as const, text: dispatchText(run, task, git, stillRunning) }],
    structuredContent: { ok: true as const, dispatch_run: run, task, ...(stillRunning ? { still_running: true } : {}) },
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = createTask(config.store, git, args);
          return okTask('Created', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = claimTask(config.store, git, actor, config.executionInstanceId, args.task_id, args.revision);
          return okTask('Claimed', task);
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
        outputSchema: taskToolOutputSchema,
      },
      () => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = claimNextTask(config.store, git, actor, config.executionInstanceId);
          return okTask('Claimed', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const task = reportResult(config.store, actor, config.executionInstanceId, args);
          return okTask('Reported', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const task = reportBlocked(config.store, actor, config.executionInstanceId, args);
          return okTask('Blocked', task);
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
          return okDispatch(run, task, postGit, stillRunning);
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
          return okDispatch(run, task, git, stillRunning);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = recoverTask(config.store, git, args);
          return okTask('Recovered', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const git = inspectRepo(config.repoPath);
          const task = resumeTask(config.store, git, args);
          return okTask('Resumed', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const task = cancelTask(config.store, args.task_id, args.revision, args.reason);
          return okTask('Cancelled', task);
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
        outputSchema: taskToolOutputSchema,
      },
      (args) => {
        try {
          const task = closeTask(config.store, args.task_id, args.revision, args.decision);
          return okTask('Closed', task);
        } catch (error) {
          return fail(error);
        }
      },
    );
  }
}
