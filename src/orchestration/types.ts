import { z } from 'zod/v4';
import type { TaskContract } from '../types.ts';

export const WORKER_OUTCOMES = ['completed', 'blocked'] as const;
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

export type WorkerValidation = {
  check: string;
  status: 'passed' | 'failed' | 'not_run';
};

export type WorkerResult = {
  outcome: WorkerOutcome;
  summary: string;
  changed_files: string[];
  validation: WorkerValidation[];
  known_limitations: string[];
  blocked_reason?: string;
  exit_code: number;
};

export const workerResultSchema = z.object({
  outcome: z.enum(WORKER_OUTCOMES),
  summary: z.string().min(1),
  changed_files: z.array(z.string()),
  validation: z.array(
    z.object({
      check: z.string().min(1),
      status: z.enum(['passed', 'failed', 'not_run']),
    }),
  ),
  known_limitations: z.array(z.string()),
  blocked_reason: z.string().optional(),
  exit_code: z.number().int().nonnegative(),
});
export type ValidatedWorkerResult = z.infer<typeof workerResultSchema>;

export type WorkerErrorCode =
  | 'CLAIM_FAILED'
  | 'ADAPTER_FAILED'
  | 'WORKER_PROCESS_FAILED'
  | 'WORKER_PROTOCOL_FAILURE'
  | 'UNEXPECTED_HEAD_CHANGE'
  | 'SCOPE_VIOLATION'
  | 'REPOSITORY_BINDING_MISMATCH'
  | 'DISPATCH_ALREADY_ACTIVE';

export type AdapterContext = {
  dispatchRunId: string;
  taskId: string;
  repositoryRoot: string;
  baseCommit: string;
  task: TaskContract;
};

export interface WorkerAdapter {
  readonly id: string;
  probe(): Promise<void>;
  execute(context: AdapterContext): Promise<WorkerResult>;
}

export type DispatchSummary = {
  dispatch_run_id: string;
  task_id: string;
  worker_role: 'JUNIOR';
  adapter_id: string;
  status: string;
  outcome?: WorkerOutcome;
  summary?: string;
  changed_files?: string[];
  validation?: WorkerValidation[];
  blocked_reason?: string;
  exit_code?: number | null;
  error_code?: string | null;
  error_detail?: string | null;
  task_status?: string;
  task_revision?: number;
  head_before?: string;
  head_after?: string;
  working_tree_clean?: boolean;
};
