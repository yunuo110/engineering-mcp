import type { McpServer } from '@modelcontextprotocol/server';
import { inspectRepo } from './git.ts';
import { isDomainError } from './errors.ts';
import {
  cancelTask,
  claimTask,
  closeTask,
  createTask,
  getTask,
  listActiveTasks,
  reportBlocked,
  resumeTask,
  reportResult,
} from './lifecycle.ts';
import { toolsForProcessRole } from './role.ts';
import type { Store } from './store.ts';
import {
  cancelTaskInputSchema,
  claimTaskInputSchema,
  closeTaskInputSchema,
  createTaskInputSchema,
  getTaskInputSchema,
  listActiveTasksInputSchema,
  listToolOutputSchema,
  processRoleToRole,
  reportBlockedInputSchema,
  reportResultInputSchema,
  resumeTaskInputSchema,
  taskToolOutputSchema,
  type ProcessRole,
  type TaskContract,
} from './types.ts';

export type ServerConfig = {
  processRole: ProcessRole;
  repoPath: string;
  store: Store;
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
          const task = claimTask(config.store, git, actor, args.task_id, args.revision);
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
          const task = reportResult(config.store, actor, args);
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
          const task = reportBlocked(config.store, actor, args);
          return okTask('Blocked', task);
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
