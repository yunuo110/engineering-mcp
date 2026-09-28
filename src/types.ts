import { z } from 'zod/v4';
export const SCHEMA_VERSION = 12;
export const BUSY_TIMEOUT_MS = 5000;
export const WRITER_PROTOCOL_GENERATION = 4;
export const ROLES = ['OWNER', 'JUNIOR', 'PRINCIPAL'] as const;
export const roleSchema = z.enum(ROLES);
export const PROCESS_ROLES = ['owner', 'junior', 'principal'] as const;
export const TASK_TYPES = ['IMPLEMENTATION', 'DIAGNOSIS'] as const;
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
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const ASSIGNEE_ROLES = ['JUNIOR', 'PRINCIPAL'] as const;
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
export const taskPayloadSchema = z.union([implementationPayloadSchema, diagnosisPayloadSchema]);
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
    if (value.verdict === 'INSUFFICIENT_EVIDENCE') {        if (value.remaining_unknowns.length === 0) {
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
export const taskResultSchema = z.union([implementationResultSchema, diagnosisResultSchema]);
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
export const reviewSourceSchema = z.object({
    checkpoint_id: z.string().min(1),
    producer_task_id: z.string().min(1),
    producer_revision: z.number().int().positive(),
    checkpoint_commit: z.string().min(1),
    checkpoint_ref: z.string().min(1),
    prior_base_commit: z.string().min(1),
});
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
export const createTaskOnceInputSchema = z.object({
    submission_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    task: createTaskInputSchema,
    worker_profile_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    scope_rules: z.array(z.object({ kind: z.enum(['FILE', 'SUBTREE']), path: z.string().min(1) }).strict()).optional(),
}).strict();
export const getWorkSubmissionInputSchema = z.object({
    submission_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();
export const resolveWorkDecisionInputSchema = z.object({
    submission_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    decision_id: z.string().regex(/^[a-f0-9]{64}$/),
    response_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    action: z.literal('RETRY_UNCHANGED'),
}).strict();
export const pendingWorkDecisionSchema = z.object({
    decision_id: z.string().regex(/^[a-f0-9]{64}$/),
    task_id: z.string().min(1),
    task_revision: z.number().int().positive(),
    decision_type: z.literal('PERMISSION_RETRY'),
    reason: z.literal('PERMISSION'),
    prompt: z.string().min(1),
    allowed_responses: z.tuple([z.literal('RETRY_UNCHANGED')]),
    created_at: z.string().min(1),
    resolved: z.literal(false),
});
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
export const claimNextTaskInputSchema = z.object({});
export const reportResultInputSchema = z.object({
    task_id: z.string().min(1),
    revision: z.number().int().positive(),
    outcome: z.enum(['completed', 'failed']),
    result: taskResultSchema,
});
export const reportBlockedInputSchema = z.object({
    task_id: z.string().min(1),
    revision: z.number().int().positive(),
    blocker: workerBlockerSchema,
});
export const resumeTaskInputSchema = z.object({
    task_id: z.string().min(1),
    revision: z.number().int().positive(),
    payload: taskPayloadSchema.optional(),
});
export const recoverTaskInputSchema = taskIdRevisionSchema;
export const checkpointPurposeSchema = z.enum(['RESUME', 'REVIEW']);
export const checkpointTaskInputSchema = taskIdRevisionSchema.extend({
    purpose: checkpointPurposeSchema,
});
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
export const checkpointStateSchema = z.enum(['PREPARED', 'GIT_APPLIED', 'FINALIZING', 'FINALIZED']);
export const createDiagnosisFromCheckpointInputSchema = z.object({
    producer_task_id: z.string().min(1),
    producer_revision: z.number().int().positive(),
    checkpoint_id: z.string().min(1),
    payload: diagnosisPayloadSchema,
}).strict();
export const delegateTaskInputSchema = taskIdRevisionSchema.extend({
    worker_profile: z.string().min(1).optional(),
});
export const awaitDelegationInputSchema = z.object({
    dispatch_run_id: z.string().min(1),
    timeout: z.number().int().positive().optional(),
});export const listWorkerProfilesInputSchema = z.object({});
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
export const taskSuccessOutputSchema = z.object({
    ok: z.literal(true),
    task: taskContractSchema,
    receipt: transitionReceiptSchema.optional(),
});
export const taskToolOutputSchema = z.discriminatedUnion('ok', [
    taskSuccessOutputSchema,
    failureOutputSchema,
]);
export const workSubmissionToolOutputSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        task: taskContractSchema,
        worker_profile_id: z.string().min(1),
        execution_group_state: z.enum(['ALIVE', 'DRAINED', 'UNKNOWN']).optional(),
        scope_rules: z.array(z.object({ kind: z.enum(['FILE', 'SUBTREE']), path: z.string().min(1) }).strict()).optional(),
        pending_decision: pendingWorkDecisionSchema.optional(),
    }),
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
export const workDecisionToolOutputSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        task: taskContractSchema,
        receipt: transitionReceiptSchema,
        response_replayed: z.boolean(),
        resolved_revision: z.number().int().positive(),
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
export const DISPATCH_STATUSES = ['launching', 'running', 'completed', 'blocked', 'failed'] as const;

export type Role = (typeof ROLES)[number];
export type ProcessRole = (typeof PROCESS_ROLES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AssigneeRole = (typeof ASSIGNEE_ROLES)[number];
export type EventKind = (typeof EVENT_KINDS)[number];

export type ImplementationPayload = z.infer<typeof implementationPayloadSchema>;
export type DiagnosisPayload = z.infer<typeof diagnosisPayloadSchema>;
export type TaskPayload = z.infer<typeof taskPayloadSchema>;
export type ValidationStatus = z.infer<typeof validationStatusSchema>;
export type ValidationCounts = z.infer<typeof validationCountsSchema>;
export type ValidationEntry = z.infer<typeof validationEntrySchema>;
export type WorkingTreeStatus = z.infer<typeof workingTreeStatusSchema>;
export type GitEvidence = z.infer<typeof gitEvidenceSchema>;
export type EnvironmentEvidence = z.infer<typeof environmentEvidenceSchema>;
export type WorkerReportedEvidence = z.infer<typeof workerReportedEvidenceSchema>;
export type RunnerObservedEvidence = z.infer<typeof runnerObservedEvidenceSchema>;
export type ServerAuthoritativeEvidence = z.infer<typeof serverAuthoritativeEvidenceSchema>;
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;
export type ImplementationResult = z.infer<typeof implementationResultSchema>;
export type DiagnosisVerdict = z.infer<typeof diagnosisVerdictSchema>;
export type DiagnosisConfidence = z.infer<typeof diagnosisConfidenceSchema>;
export type ImplementationRecommendation = z.infer<typeof implementationRecommendationSchema>;
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type BlockerReason = z.infer<typeof blockerReasonSchema>;
export type RecoveryMetadata = z.infer<typeof recoveryMetadataSchema>;
export type WorkerBlocker = z.infer<typeof workerBlockerSchema>;
export type Blocker = z.infer<typeof blockerSchema>;
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type TaskIdRevision = z.infer<typeof taskIdRevisionSchema>;
export type ClaimTicket = z.infer<typeof claimTicketSchema>;
export type ReportResultInput = z.infer<typeof reportResultInputSchema>;
export type ReportBlockedInput = z.infer<typeof reportBlockedInputSchema>;
export type ResumeTaskInput = z.infer<typeof resumeTaskInputSchema>;
export type RecoverTaskInput = z.infer<typeof recoverTaskInputSchema>;
export type CheckpointPurpose = z.infer<typeof checkpointPurposeSchema>;
export type CheckpointTaskInput = z.infer<typeof checkpointTaskInputSchema>;
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;
export type CheckpointState = z.infer<typeof checkpointStateSchema>;
export type CreateDiagnosisFromCheckpointInput = z.infer<typeof createDiagnosisFromCheckpointInputSchema>;
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;
export type AwaitDelegationInput = z.infer<typeof awaitDelegationInputSchema>;
export type WorkerProfileSummary = z.infer<typeof workerProfileSummarySchema>;
export type TransitionReceipt = z.infer<typeof transitionReceiptSchema>;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export type GitSnapshot = {
  repoRoot: string;
  branch: string;
  head: string;
  clean: boolean;
  porcelain: string;
};

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
