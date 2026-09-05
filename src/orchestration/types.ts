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
