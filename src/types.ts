import { z } from 'zod/v4';

export const SCHEMA_VERSION = 8;
export const BUSY_TIMEOUT_MS = 5000;
export const WRITER_PROTOCOL_GENERATION = 3;

export const ROLES = ['OWNER', 'JUNIOR', 'PRINCIPAL'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const PROCESS_ROLES = ['owner', 'junior', 'principal'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const TASK_TYPES = ['IMPLEMENTATION', 'DIAGNOSIS'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const taskTypeSchema = z.enum(TASK_TYPES);

export const TASK_STATUSES = [
  'READY',
  'RUNNING',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
  'CLOSED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusSchema = z.enum(TASK_STATUSES);

export const ASSIGNEE_ROLES = ['JUNIOR', 'PRINCIPAL'] as const;
export type AssigneeRole = (typeof ASSIGNEE_ROLES)[number];
export const assigneeRoleSchema = z.enum(ASSIGNEE_ROLES);

export const EVENT_KINDS = [
  'created',
  'claimed',
  'result',
  'blocked',
  'resumed',
  'cancelled',
  'closed',
  'checkpointed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const eventKindSchema = z.enum(EVENT_KINDS);

export const implementationPayloadSchema = z.object({
  goal: z.string().min(1),
  parent_intent: z.string().min(1),
  allowed_scope: z.array(z.string()),
  forbidden_scope: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  validation_requirements: z.array(z.string()),
  context_files: z.array(z.string()),
  knowledge_refs: z.array(z.string()),
  parent_risk: z.string().min(1),
});
export type ImplementationPayload = z.infer<typeof implementationPayloadSchema>;

export const diagnosisPayloadSchema = z.object({
  problem: z.string().min(1),
  desired_outcome: z.string().min(1),
  confirmed_facts: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  disproved_hypotheses: z.array(z.string()),
  open_questions: z.array(z.string()),
  constraints: z.array(z.string()),
  context_files: z.array(z.string()),
  knowledge_refs: z.array(z.string()),
  risk: z.string().min(1),
});
export type DiagnosisPayload = z.infer<typeof diagnosisPayloadSchema>;

export const taskPayloadSchema = z.union([implementationPayloadSchema, diagnosisPayloadSchema]);
export type TaskPayload = z.infer<typeof taskPayloadSchema>;

export const validationStatusSchema = z.enum(['passed', 'failed', 'not_run']);

export const validationCountsSchema = z.object({
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});

export const validationEntrySchema = z
  .object({
    check: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    status: validationStatusSchema,
    summary: z.string().min(1).optional(),
    counts: validationCountsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.check && !value.command) {
      ctx.addIssue({
        code: 'custom',
        message: 'validation evidence requires check or command',
        path: ['check'],
      });
    }
  });

export const workingTreeStatusSchema = z.object({
  clean: z.boolean(),
  porcelain: z.string(),
});

export const gitEvidenceSchema = z.object({
  head: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  working_tree_status: workingTreeStatusSchema.optional(),
  diff_check: z
    .object({
      command: z.string().min(1).optional(),
      status: validationStatusSchema,
      summary: z.string().min(1).optional(),
    })
    .optional(),
});

export const environmentEvidenceSchema = z.object({
  cwd: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

export const workerReportedEvidenceSchema = z.object({
  implementation_complete: z.boolean().optional(),
  changed_files: z.array(z.string()).optional(),
  validation: z.array(validationEntrySchema).optional(),
  git: gitEvidenceSchema.optional(),
  environment: environmentEvidenceSchema.optional(),
  blocker_classification: z.lazy(() => blockerReasonSchema).optional(),
});

export const runnerObservedEvidenceSchema = z.object({
  changed_files: z.array(z.string()),
  git: z.object({
    head: z.string().min(1),
    branch: z.string().min(1),
    working_tree_status: workingTreeStatusSchema,
  }),
  scope: z.object({
    status: z.enum(['passed', 'failed']),
    rejected_files: z.array(z.string()),
  }),
});

export const serverAuthoritativeEvidenceSchema = z.object({
  task_id: z.string().min(1),
  task_type: taskTypeSchema,
  producer_revision: z.number().int().positive(),
  actor_role: roleSchema,
  repo_root: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
});

export const evidenceEnvelopeSchema = z.object({
  worker_reported: workerReportedEvidenceSchema.optional(),
  runner_observed: runnerObservedEvidenceSchema.optional(),
  server_authoritative: serverAuthoritativeEvidenceSchema.optional(),
});
export type RunnerObservedEvidence = z.infer<typeof runnerObservedEvidenceSchema>;

export const implementationResultSchema = z.object({
  summary: z.string().min(1),
  implementation_complete: z.boolean().optional(),
  changed_files: z.array(z.string()),
  validation: z.array(validationEntrySchema),
  git: gitEvidenceSchema.optional(),
  environment: environmentEvidenceSchema.optional(),
  existing_tests_changed: z.array(z.string()),
  scope_changes: z.array(z.string()),
  unverified: z.array(z.string()),
  working_tree_status: workingTreeStatusSchema,
  evidence: evidenceEnvelopeSchema.optional(),
});
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const diagnosisVerdictSchema = z.enum(['CONFIRMED', 'MOST_LIKELY', 'INSUFFICIENT_EVIDENCE']);
export const diagnosisConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const implementationRecommendationSchema = z.enum([
  'RETURN_TO_GROK',
  'DELEGATE_TO_LUNA',
  'SOL_DIRECT',
]);

export const diagnosisResultSchema = z
  .object({
    verdict: diagnosisVerdictSchema,
    root_cause: z.string().min(1).optional(),
    violated_invariant: z.string().min(1).optional(),
    evidence_refs: z.array(z.string()),
    alternatives_ruled_out: z.array(z.string()),
    minimal_repair: z.string().min(1).optional(),
    files_to_change: z.array(z.string()).optional(),
    files_not_to_change: z.array(z.string()).optional(),
    required_validation: z.array(z.string()).optional(),
    implementation_recommendation: implementationRecommendationSchema,
    confidence: diagnosisConfidenceSchema,
    remaining_unknowns: z.array(z.string()),
    implementation_complete: z.boolean().optional(),
    changed_files: z.array(z.string()).optional(),
    validation: z.array(validationEntrySchema).optional(),
    git: gitEvidenceSchema.optional(),
    environment: environmentEvidenceSchema.optional(),
    evidence: evidenceEnvelopeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'INSUFFICIENT_EVIDENCE') {
      if (value.remaining_unknowns.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'INSUFFICIENT_EVIDENCE requires remaining_unknowns',
          path: ['remaining_unknowns'],
        });
      }
      return;
    }
    if (!value.root_cause) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.verdict} requires root_cause`,
        path: ['root_cause'],
      });
    }
    if (!value.minimal_repair) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.verdict} requires minimal_repair`,
        path: ['minimal_repair'],
      });
    }
  });
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

export const taskResultSchema = z.union([implementationResultSchema, diagnosisResultSchema]);
export type TaskResult = z.infer<typeof taskResultSchema>;

export const blockerReasonSchema = z.enum([
  'CODE',
  'TEST_FAILURE',
  'VALIDATION_ENVIRONMENT',
  'PERMISSION',
  'TOOL_FAILURE',
  'EXTERNAL_DEPENDENCY',
  'SCOPE_CONFLICT',
  'PLAN_CONFLICT',
  'DECISION_REQUIRED',
  'CONTEXT_STALE',
  'REPOSITORY_DIVERGED',
  'OTHER',
]);

export const recoveryMetadataSchema = z.object({
  reason: z.enum(['SERVER_RESTART', 'EXPLICIT_OWNER_RECOVERY']),
  previous_status: z.literal('RUNNING'),
  detected_at: z.string().min(1),
  detected_by_role: roleSchema,
  retry_safe: z.boolean(),
  prior_execution_instance_id: z.string().optional(),
});
export type RecoveryMetadata = z.infer<typeof recoveryMetadataSchema>;

const blockerFieldsSchema = z.object({
  reason: blockerReasonSchema,
  summary: z.string().min(1),
  need_from_owner: z.string().min(1),
  evidence_refs: z.array(z.string()),
  implementation_complete: z.boolean().optional(),
  changed_files: z.array(z.string()).optional(),
  validation: z.array(validationEntrySchema).optional(),
  git: gitEvidenceSchema.optional(),
  environment: environmentEvidenceSchema.optional(),
  evidence: evidenceEnvelopeSchema.optional(),
});

export const workerBlockerSchema = blockerFieldsSchema;
export const blockerSchema = blockerFieldsSchema.extend({
  recovery: recoveryMetadataSchema.optional(),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const reviewSourceSchema = z.object({
  checkpoint_id: z.string().min(1),
  producer_task_id: z.string().min(1),
  producer_revision: z.number().int().positive(),
  checkpoint_commit: z.string().min(1),
  checkpoint_ref: z.string().min(1),
  prior_base_commit: z.string().min(1),
});
export type ReviewSource = z.infer<typeof reviewSourceSchema>;

export const taskContractSchema = z.object({
  id: z.string().min(1),
  type: taskTypeSchema,
  status: taskStatusSchema,
  owner_role: z.literal('OWNER'),
  assignee_role: assigneeRoleSchema.nullable(),
  execution_instance_id: z.string().nullable(),
  writer_generation: z.number().int().nonnegative(),
  repo_root: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
  source_checkpoint: reviewSourceSchema.nullable(),
  payload: taskPayloadSchema,
  result: taskResultSchema.nullable(),
  blocker: blockerSchema.nullable(),
  revision: z.number().int().positive(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type TaskContract = z.infer<typeof taskContractSchema>;

export const createTaskInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('IMPLEMENTATION'),
      payload: implementationPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('DIAGNOSIS'),
      payload: diagnosisPayloadSchema,
    })
    .strict(),
]);
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const taskIdRevisionSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
});

export const getTaskInputSchema = z.object({
  task_id: z.string().min(1),
});

export const listActiveTasksInputSchema = z.object({
  type: taskTypeSchema.optional(),
});

export const claimTaskInputSchema = taskIdRevisionSchema;

export const inspectClaimableTaskInputSchema = getTaskInputSchema;

export const claimTicketSchema = z.object({
  task_id: z.string().min(1),
  type: taskTypeSchema,
  status: z.literal('READY'),
  revision: z.number().int().positive(),
  assignee_role: assigneeRoleSchema,
  repo_root: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
});
export type ClaimTicket = z.infer<typeof claimTicketSchema>;

export const claimNextTaskInputSchema = z.object({});

export const reportResultInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  outcome: z.enum(['completed', 'failed']),
  result: taskResultSchema,
});
export type ReportResultInput = z.infer<typeof reportResultInputSchema>;

export const reportBlockedInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  blocker: workerBlockerSchema,
});
export type ReportBlockedInput = z.infer<typeof reportBlockedInputSchema>;

export const resumeTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  payload: taskPayloadSchema.optional(),
});
export type ResumeTaskInput = z.infer<typeof resumeTaskInputSchema>;

export const recoverTaskInputSchema = taskIdRevisionSchema;
export type RecoverTaskInput = z.infer<typeof recoverTaskInputSchema>;

export const checkpointPurposeSchema = z.enum(['RESUME', 'REVIEW']);
export type CheckpointPurpose = z.infer<typeof checkpointPurposeSchema>;

export const checkpointTaskInputSchema = taskIdRevisionSchema.extend({
  purpose: checkpointPurposeSchema,
});
export type CheckpointTaskInput = z.infer<typeof checkpointTaskInputSchema>;

export const taskCheckpointSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  producer_revision: z.number().int().positive(),
  purpose: checkpointPurposeSchema,
  state: z.literal('FINALIZED'),
  request_identity: z.string().min(1),
  repo_root: z.string().min(1),
  prior_base_commit: z.string().min(1),
  expected_tree: z.string().min(1),
  scope_identity: z.string().min(1),
  checkpoint_commit: z.string().min(1),
  checkpoint_ref: z.string().min(1),
  branch: z.string().min(1),
  changed_files: z.array(z.string()),
  created_at: z.string().min(1),
  finalized_at: z.string().min(1),
});
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

export const checkpointStateSchema = z.enum(['PREPARED', 'GIT_APPLIED', 'FINALIZING', 'FINALIZED']);
export type CheckpointState = z.infer<typeof checkpointStateSchema>;

export type CheckpointIntent = {
  id: string;
  task_id: string;
  producer_revision: number;
  purpose: CheckpointPurpose;
  state: CheckpointState;
  request_identity: string;
  repo_root: string;
  prior_base_commit: string;
  expected_tree: string;
  scope_identity: string;
  checkpoint_commit: string | null;
  checkpoint_ref: string;
  branch: string;
  changed_files: string[];
  created_at: string;
  finalized_at: string | null;
};

export const createDiagnosisFromCheckpointInputSchema = z.object({
  producer_task_id: z.string().min(1),
  producer_revision: z.number().int().positive(),
  checkpoint_id: z.string().min(1),
  payload: diagnosisPayloadSchema,
}).strict();
export type CreateDiagnosisFromCheckpointInput = z.infer<typeof createDiagnosisFromCheckpointInputSchema>;

export const delegateTaskInputSchema = taskIdRevisionSchema.extend({
  worker_profile: z.string().min(1).optional(),
});
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

export const awaitDelegationInputSchema = z.object({
  dispatch_run_id: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});
export type AwaitDelegationInput = z.infer<typeof awaitDelegationInputSchema>;

export const listWorkerProfilesInputSchema = z.object({});

export const workerProfileSummarySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  adapter: z.string().min(1),
  default: z.boolean(),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const listWorkerProfilesSuccessOutputSchema = z.object({
  ok: z.literal(true),
  profiles: z.array(workerProfileSummarySchema),
});

export const domainErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const failureOutputSchema = z.object({
  ok: z.literal(false),
  error: domainErrorBodySchema,
});

export const listWorkerProfilesOutputSchema = z.discriminatedUnion('ok', [
  listWorkerProfilesSuccessOutputSchema,
  failureOutputSchema,
]);

export const dispatchToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    dispatch_run: z.record(z.string(), z.unknown()),
    task: taskContractSchema,
    receipt: z.lazy(() => transitionReceiptSchema),
    still_running: z.boolean().optional(),
  }),
  failureOutputSchema,
]);

export const cancelTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  reason: z.string().min(1).optional(),
});

export const closeTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  decision: z.string().min(1).optional(),
});

export const delegationReceiptSchema = z.object({
  dispatch_run_id: z.string().min(1),
  worker_profile: z.string().min(1).nullable(),
  worker_role: assigneeRoleSchema,
  adapter_id: z.string().min(1),
  state: z.string().min(1),
});

export const transitionReceiptSchema = z.object({
  task_id: z.string().min(1),
  type: taskTypeSchema,
  previous_status: taskStatusSchema.nullable(),
  status: taskStatusSchema,
  revision: z.number().int().positive(),
  assignee_role: assigneeRoleSchema.nullable(),
  repo_root: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
  delegation: delegationReceiptSchema.optional(),
  checkpoint: taskCheckpointSchema.optional(),
  source_checkpoint: reviewSourceSchema.optional(),
});
export type TransitionReceipt = z.infer<typeof transitionReceiptSchema>;


export const taskSuccessOutputSchema = z.object({
  ok: z.literal(true),
  task: taskContractSchema,
  receipt: transitionReceiptSchema.optional(),
});

export const taskToolOutputSchema = z.discriminatedUnion('ok', [
  taskSuccessOutputSchema,
  failureOutputSchema,
]);

export const transitionTaskToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    task: taskContractSchema,
    receipt: transitionReceiptSchema,
  }),
  failureOutputSchema,
]);

export const listSuccessOutputSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(taskContractSchema),
});

export const listToolOutputSchema = z.discriminatedUnion('ok', [
  listSuccessOutputSchema,
  failureOutputSchema,
]);

export const claimTicketToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    claim_ticket: claimTicketSchema,
  }),
  failureOutputSchema,
]);

export const checkpointToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    task: taskContractSchema,
    checkpoint: taskCheckpointSchema,
    receipt: transitionReceiptSchema,
  }),
  failureOutputSchema,
]);

export type GitSnapshot = {
  repoRoot: string;
  branch: string;
  head: string;
  clean: boolean;
  porcelain: string;
};

export type TaskEvent = {
  id: number;
  task_id: string;
  at: string;
  actor_role: Role;
  kind: EventKind;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  revision: number;
  detail: Record<string, unknown> | null;
};

export const DISPATCH_STATUSES = ['launching', 'running', 'completed', 'blocked', 'failed'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export type DispatchRun = {
  id: string;
  task_id: string;
  worker_role: 'JUNIOR';
  adapter_id: string;
  worker_profile_id: string | null;
  runner_instance_id: string | null;
  pid: number | null;
  status: DispatchStatus;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
};

export function processRoleToRole(processRole: ProcessRole): Role {
  if (processRole === 'owner') {
    return 'OWNER';
  }
  if (processRole === 'junior') {
    return 'JUNIOR';
  }
  return 'PRINCIPAL';
}

export function assigneeForType(type: TaskType): AssigneeRole {
  return type === 'IMPLEMENTATION' ? 'JUNIOR' : 'PRINCIPAL';
}

export function nowIso(): string {
  return new Date().toISOString();
}
