import { z } from 'zod/v4';
import {
  blockerReasonSchema,
  environmentEvidenceSchema,
  gitEvidenceSchema,
  validationEntrySchema,
  type TaskContract,
} from '../types.ts';

export const WORKER_OUTCOMES = ['completed', 'blocked'] as const;
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

export type WorkerValidation = z.infer<typeof validationEntrySchema>;

export type WorkerResult = {
  outcome: WorkerOutcome;
  summary: string;
  changed_files: string[];
  validation: WorkerValidation[];
  known_limitations: string[];
  blocked_reason?: string;
  blocker_classification?: z.infer<typeof blockerReasonSchema>;
  implementation_complete?: boolean;
  git?: z.infer<typeof gitEvidenceSchema>;
  environment?: z.infer<typeof environmentEvidenceSchema>;
  exit_code: number;
  /** Trusted adapter observation. This field is not part of EWP and is never parsed from worker output. */
  runner_error_code?:
    | 'WORKER_PROCESS_FAILED'
    | 'WORKER_PROTOCOL_FAILURE'
    | 'CODEX_ARTIFACT_MISMATCH'
    | 'CODEX_PROCESS_FAILED';
};

export const workerResultSchema = z.object({
  outcome: z.enum(WORKER_OUTCOMES),
  summary: z.string().min(1),
  changed_files: z.array(z.string()),
  validation: z.array(validationEntrySchema),
  known_limitations: z.array(z.string()),
  blocked_reason: z.string().optional(),
  blocker_classification: blockerReasonSchema.optional(),
  implementation_complete: z.boolean().optional(),
  git: gitEvidenceSchema.optional(),
  environment: environmentEvidenceSchema.optional(),
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
