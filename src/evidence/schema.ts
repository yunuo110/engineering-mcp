import { z } from 'zod/v4';
import {
  DISPATCH_STATUSES,
  blockerSchema,
  eventKindSchema,
  roleSchema,
  recoveryMetadataSchema,
  taskCheckpointSchema,
  taskContractSchema,
  taskResultSchema,
  taskStatusSchema,
  validationEntrySchema,
  type Blocker,
  type DispatchRun,
  type Role,
  type TaskCheckpoint,
  type TaskContract,
  type TaskEvent,
  type TaskResult,
} from '../types.ts';

export const EVIDENCE_RESULTS = ['PASSED', 'FAILED', 'NOT_RUN', 'UNKNOWN'] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

export const EVIDENCE_VERIFICATIONS = ['VERIFIED', 'REPORTED', 'UNAVAILABLE'] as const;
export type EvidenceVerification = (typeof EVIDENCE_VERIFICATIONS)[number];

export const evidenceResultSchema = z.enum(EVIDENCE_RESULTS);
export const evidenceVerificationSchema = z.enum(EVIDENCE_VERIFICATIONS);
export type EvidenceValidationEntry = z.infer<typeof validationEntrySchema>;

export const executionSelectorSchema = z.union([
  z
    .object({
      task_id: z.string().min(1),
      dispatch_run_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      task_id: z.string().min(1),
      execution_instance_id: z.string().min(1),
    })
    .strict(),
]);

export type ExecutionSelector = z.infer<typeof executionSelectorSchema>;

export const taskEventSnapshotSchema = z
  .object({
    id: z.number().int().positive(),
    task_id: z.string().min(1),
    at: z.string().min(1),
    actor_role: roleSchema,
    kind: eventKindSchema,
    from_status: taskStatusSchema.nullable(),
    to_status: taskStatusSchema,
    revision: z.number().int().positive(),
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const dispatchRunSnapshotSchema = z
  .object({
    id: z.string().min(1),
    task_id: z.string().min(1),
    worker_role: z.literal('JUNIOR'),
    adapter_id: z.string().min(1),
    worker_profile_id: z.string().min(1).nullable(),
    runner_instance_id: z.string().min(1).nullable(),
    pid: z.number().int().nullable(),
    status: z.enum(DISPATCH_STATUSES),
    started_at: z.string().min(1).nullable(),
    finished_at: z.string().min(1).nullable(),
    exit_code: z.number().int().nullable(),
    error_code: z.string().min(1).nullable(),
    error_detail: z.string().min(1).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export const executionEvidenceSnapshotSchema = z
  .object({
    trusted_repo_root: z.string().min(1),
    task: taskContractSchema,
    task_events: z.array(taskEventSnapshotSchema),
    dispatch: dispatchRunSnapshotSchema.optional(),
    checkpoints: z.array(taskCheckpointSchema).optional(),
  })
  .strict();

export type ExecutionEvidenceSnapshot = {
  trusted_repo_root: string;
  task: TaskContract;
  task_events: TaskEvent[];
  dispatch?: DispatchRun;
  checkpoints?: TaskCheckpoint[];
};

export const resultEventDetailSchema = z
  .object({
    outcome: z.enum(['completed', 'failed']),
    result: taskResultSchema,
  })
  .strict();

export const workerBlockedEventDetailSchema = z
  .object({
    blocker: blockerSchema,
  })
  .strict();

export const recoveryBlockedEventDetailSchema = z
  .object({
    recovery: recoveryMetadataSchema,
    prior_execution_instance_id: z.string().nullable(),
    blocker: blockerSchema,
  })
  .strict();

export const claimedEventDetailSchema = z
  .object({
    execution_instance_id: z.string().min(1),
  })
  .strict();

export const EVIDENCE_ERROR_CODES = [
  'INVALID_SELECTOR',
  'INVALID_SNAPSHOT',
  'TASK_MISMATCH',
  'REPOSITORY_MISMATCH',
  'FOREIGN_TASK_EVENT',
  'FOREIGN_TASK_CHECKPOINT',
  'DISPATCH_REQUIRED',
  'DISPATCH_MISMATCH',
  'EXECUTION_PROVENANCE_MISMATCH',
  'MALFORMED_EVENT_DETAIL',
  'EXECUTION_CLAIM_NOT_FOUND',
  'AMBIGUOUS_EXECUTION_CLAIM',
  'AMBIGUOUS_TERMINAL_EVENT',
  'TERMINAL_PROVENANCE_MISMATCH',
  'AMBIGUOUS_REVIEW_CHECKPOINT',
  'CHECKPOINT_PROVENANCE_MISMATCH',
] as const;

export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

export type EvidenceProjectionError = {
  code: EvidenceErrorCode;
  message: string;
};

export type EvidenceProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EvidenceProjectionError };

export type ReviewSnapshotProjection = {
  verification: 'VERIFIED';
  checkpoint_id: string;
  producer_revision: number;
  checkpoint_commit: string;
  checkpoint_ref: string;
  prior_base_commit: string;
  changed_files: string[];
  finalized_at: string;
};

export type ExecutionSummaryProjection = {
  task_id: string;
  task_type: TaskContract['type'];
  repo_root: string;
  execution: {
    execution_instance_id: string | null;
    dispatch_run_id: string | null;
    adapter_id: string | null;
    worker_profile_id: string | null;
  };
  lifecycle: {
    claim_revision: number | null;
    terminal_revision: number | null;
    actor_role: Role | null;
    outcome: 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'RUNNING' | 'NOT_CLAIMED';
    verification: 'VERIFIED' | 'UNAVAILABLE';
  };
  process: {
    status: DispatchRun['status'] | null;
    started_at: string | null;
    finished_at: string | null;
    exit_code: number | null;
    error_code: string | null;
    error_detail: string | null;
    verification: 'VERIFIED' | 'UNAVAILABLE';
  };
  reported_summary: {
    value: string | null;
    verification: 'REPORTED' | 'UNAVAILABLE';
  };
  review_snapshot: ReviewSnapshotProjection | null;
};

export type TestStatusEntryProjection = {
  check?: string;
  command?: string;
  summary?: string;
  counts?: z.infer<typeof validationEntrySchema>['counts'];
  result: Exclude<EvidenceResult, 'UNKNOWN'>;
  verification: 'REPORTED';
};

export type TestStatusProjection = {
  task_id: string;
  execution_instance_id: string | null;
  dispatch_run_id: string | null;
  entries: TestStatusEntryProjection[];
  overall: {
    result: EvidenceResult;
    verification: 'REPORTED' | 'UNAVAILABLE';
  };
};
export type ExecutionOutputProjection = {
  task_id: string;
  execution_instance_id: string | null;
  dispatch_run_id: string | null;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  terminal_kind: 'RESULT' | 'BLOCKER' | null;
  terminal_revision: number | null;
  persisted_terminal: TaskResult | Blocker | null;
  worker_reported: {
    verification: 'REPORTED' | 'UNAVAILABLE';
    value: Record<string, unknown> | null;
  };
  runner_observed: {
    verification: 'VERIFIED' | 'UNAVAILABLE';
    value: Record<string, unknown> | null;
  };
  server_authoritative: {
    verification: 'VERIFIED' | 'UNAVAILABLE';
    value: Record<string, unknown> | null;
  };
  dispatch: {
    verification: 'VERIFIED' | 'UNAVAILABLE';
    value: DispatchRun | null;
  };
  review_snapshot: ReviewSnapshotProjection | null;
  raw_streams: {
    stdout: 'UNAVAILABLE';
    stderr: 'UNAVAILABLE';
  };
};
