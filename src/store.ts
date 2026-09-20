import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from './errors.ts';
import {
  durableC2CEvaluationReceiptSchema,
  type DurableC2CEvaluationReceipt,
} from './receipts/schema.ts';
import {
  normalizedPlanAcceptanceRowSchema,
  planAcceptanceReceiptSchema,
  type NormalizedPlanAcceptanceRow,
  type PlanAcceptanceReceipt,
} from './commands/schema.ts';
import {
  c2cDelegationIntentReceiptSchema,
  normalizedC2CDelegationReceiptRowSchema,
  type C2CDelegationIntentReceipt,
  type NormalizedC2CDelegationReceiptRow,
} from './commands/delegation-schema.ts';
import {
  BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  WRITER_PROTOCOL_GENERATION,
  blockerSchema,
  checkpointPurposeSchema,
  checkpointStateSchema,
  eventKindSchema,
  roleSchema,
  taskContractSchema,
  taskCheckpointSchema,
  taskPayloadSchema,
  taskResultSchema,
  taskStatusSchema,
  type DispatchRun,
  type CheckpointIntent,
  type EventKind,
  type Role,
  type TaskContract,
  type TaskCheckpoint,
  type TaskEvent,
  type TaskStatus,
  type TaskType,
} from './types.ts';

const CREATE_SCHEMA_SQL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  assignee_role TEXT,
  execution_instance_id TEXT,
  writer_generation INTEGER,
  repo_root TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  source_checkpoint_id TEXT,
  source_task_id TEXT,
  source_task_revision INTEGER,
  source_checkpoint_commit TEXT,
  source_checkpoint_ref TEXT,
  source_prior_base_commit TEXT,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  blocker_json TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (type IN ('IMPLEMENTATION', 'DIAGNOSIS')),
  CHECK (status IN ('READY','RUNNING','BLOCKED','FAILED','CANCELLED','COMPLETED','CLOSED')),
  CHECK (owner_role = 'OWNER'),
  CHECK (assignee_role IN ('JUNIOR','PRINCIPAL') OR assignee_role IS NULL),
  CHECK (revision >= 1)
) STRICT;

CREATE UNIQUE INDEX one_running_task ON tasks(status) WHERE status = 'RUNNING';

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  detail_json TEXT,
  writer_generation INTEGER NOT NULL DEFAULT 1,
  CHECK (actor_role IN ('OWNER','JUNIOR','PRINCIPAL')),
  CHECK (kind IN ('created','claimed','result','blocked','resumed','cancelled','closed','checkpointed'))
) STRICT;

CREATE TABLE ledger_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE dispatch_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_role TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  worker_profile_id TEXT,
  writer_generation INTEGER NOT NULL DEFAULT 1,
  runner_instance_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (worker_role IN ('JUNIOR')),
  CHECK (status IN ('launching','running','completed','blocked','failed'))
) STRICT;

CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  producer_revision INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL,
  request_identity TEXT NOT NULL UNIQUE,
  repo_root TEXT NOT NULL,
  prior_base_commit TEXT NOT NULL,
  expected_tree TEXT NOT NULL,
  scope_identity TEXT NOT NULL,
  checkpoint_commit TEXT UNIQUE,
  checkpoint_ref TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE (task_id, producer_revision),
  CHECK (purpose IN ('RESUME','REVIEW')),
  CHECK (state IN ('PREPARED','GIT_APPLIED','FINALIZING','FINALIZED')),
  CHECK ((state IN ('PREPARED','GIT_APPLIED') AND checkpoint_commit IS NULL AND finalized_at IS NULL)
      OR (state = 'FINALIZING' AND checkpoint_commit IS NOT NULL AND finalized_at IS NULL)
      OR (state = 'FINALIZED' AND checkpoint_commit IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (producer_revision >= 1)
) STRICT;

CREATE TABLE c2c_evaluation_receipts (
  message_id TEXT PRIMARY KEY,
  message_digest TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  evaluated_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(message_digest) = 64),
  CHECK (evaluated_revision >= 1),
  CHECK (decision IN ('REQUIRES_OWNER_ACTION','READY_FOR_REVIEW'))
) STRICT;

CREATE TABLE c2c_plan_acceptance_receipts (
  command_id TEXT PRIMARY KEY,
  evaluation_message_id TEXT NOT NULL UNIQUE REFERENCES c2c_evaluation_receipts(message_id),
  accepted_at TEXT NOT NULL
) STRICT;

CREATE TABLE c2c_delegation_receipts (
  command_id TEXT PRIMARY KEY,
  acceptance_command_id TEXT NOT NULL UNIQUE REFERENCES c2c_plan_acceptance_receipts(command_id),
  dispatch_run_id TEXT NOT NULL UNIQUE REFERENCES dispatch_runs(id),
  launch_spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_unfinished_checkpoint
ON task_checkpoints((1))
WHERE state != 'FINALIZED';

CREATE UNIQUE INDEX one_active_dispatch_per_task
ON dispatch_runs(task_id)
WHERE status IN ('launching','running');

CREATE TRIGGER trg_task_checkpoints_exclusive_insert
BEFORE INSERT ON task_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'TASK_ALREADY_RUNNING task=' || t.id)
  FROM tasks t WHERE t.status = 'RUNNING' LIMIT 1;
  SELECT RAISE(ABORT, 'CHECKPOINT_ACTIVE_DISPATCH dispatch=' || d.id || ' task=' || d.task_id)
  FROM dispatch_runs d WHERE d.status IN ('launching','running') LIMIT 1;
END;

CREATE TRIGGER trg_task_checkpoints_single_unfinished_insert
BEFORE INSERT ON task_checkpoints
WHEN NEW.state != 'FINALIZED'
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
  FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
END;

CREATE TRIGGER trg_tasks_execution_invariant_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
  WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
     OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
END;

CREATE TRIGGER trg_tasks_execution_invariant_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
  WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
     OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
END;

CREATE TRIGGER trg_tasks_repository_invariant_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
  WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
     OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
END;

CREATE TRIGGER trg_tasks_repository_invariant_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
  WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
     OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
END;

CREATE TRIGGER trg_tasks_running_immutable_update
BEFORE UPDATE ON tasks
WHEN OLD.status = 'RUNNING' AND NEW.status = 'RUNNING'
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION');
END;

CREATE TRIGGER trg_tasks_writer_protocol_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
  WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
END;

CREATE TRIGGER trg_tasks_writer_protocol_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
  WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != OLD.writer_generation + ${WRITER_PROTOCOL_GENERATION};
END;

CREATE TRIGGER trg_task_events_writer_protocol_insert
BEFORE INSERT ON task_events
BEGIN
  SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
  WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
END;

CREATE TRIGGER trg_dispatch_runs_writer_protocol_insert
BEFORE INSERT ON dispatch_runs
BEGIN
  SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
  WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
END;

CREATE TRIGGER trg_dispatch_runs_writer_protocol_update
BEFORE UPDATE ON dispatch_runs
BEGIN
  SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
  WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != OLD.writer_generation + ${WRITER_PROTOCOL_GENERATION};
END;

CREATE TRIGGER trg_tasks_checkpoint_fence_update
BEFORE UPDATE ON tasks
WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
  FROM task_checkpoints c
  WHERE c.state != 'FINALIZED' AND NOT EXISTS (
    SELECT 1 FROM task_checkpoints c
    WHERE c.task_id = OLD.id AND c.state = 'FINALIZING'
      AND OLD.revision = c.producer_revision AND NEW.revision = c.producer_revision + 1
      AND NEW.base_commit = c.checkpoint_commit AND NEW.status = OLD.status
      AND NEW.assignee_role IS OLD.assignee_role
      AND NEW.execution_instance_id IS OLD.execution_instance_id
      AND NEW.type = OLD.type AND NEW.owner_role = OLD.owner_role
      AND NEW.repo_root = OLD.repo_root AND NEW.branch = OLD.branch
      AND NEW.payload_json = OLD.payload_json
      AND NEW.result_json IS OLD.result_json AND NEW.blocker_json IS OLD.blocker_json
      AND NEW.source_checkpoint_id IS OLD.source_checkpoint_id
      AND NEW.source_task_id IS OLD.source_task_id
      AND NEW.source_task_revision IS OLD.source_task_revision
      AND NEW.source_checkpoint_commit IS OLD.source_checkpoint_commit
      AND NEW.source_checkpoint_ref IS OLD.source_checkpoint_ref
      AND NEW.source_prior_base_commit IS OLD.source_prior_base_commit
      AND NEW.created_at = OLD.created_at
  ) LIMIT 1;
END;

CREATE TRIGGER trg_tasks_checkpoint_fence_insert
BEFORE INSERT ON tasks
WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
  FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
END;

CREATE TRIGGER trg_dispatch_runs_checkpoint_fence_insert
BEFORE INSERT ON dispatch_runs
WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
  FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
END;

CREATE TRIGGER trg_dispatch_runs_checkpoint_fence_update
BEFORE UPDATE ON dispatch_runs
WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
  FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
END;

CREATE TRIGGER trg_tasks_review_source_insert
BEFORE INSERT ON tasks
WHEN NEW.source_checkpoint_id IS NOT NULL OR NEW.source_task_id IS NOT NULL
  OR NEW.source_task_revision IS NOT NULL OR NEW.source_checkpoint_commit IS NOT NULL
  OR NEW.source_checkpoint_ref IS NOT NULL OR NEW.source_prior_base_commit IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CHECKPOINT_BINDING_MISMATCH')
  WHERE NEW.type != 'DIAGNOSIS' OR NOT EXISTS (
    SELECT 1 FROM task_checkpoints c
    WHERE c.id = NEW.source_checkpoint_id AND c.state = 'FINALIZED' AND c.purpose = 'REVIEW'
      AND c.task_id = NEW.source_task_id AND c.producer_revision = NEW.source_task_revision
      AND c.checkpoint_commit = NEW.source_checkpoint_commit AND c.checkpoint_ref = NEW.source_checkpoint_ref
      AND c.prior_base_commit = NEW.source_prior_base_commit
      AND NEW.base_commit = c.checkpoint_commit AND NEW.repo_root = c.repo_root AND NEW.branch = c.branch
  );
END;

CREATE TRIGGER trg_tasks_review_source_update
BEFORE UPDATE ON tasks
WHEN NEW.source_checkpoint_id IS NOT OLD.source_checkpoint_id
  OR NEW.source_task_id IS NOT OLD.source_task_id
  OR NEW.source_task_revision IS NOT OLD.source_task_revision
  OR NEW.source_checkpoint_commit IS NOT OLD.source_checkpoint_commit
  OR NEW.source_checkpoint_ref IS NOT OLD.source_checkpoint_ref
  OR NEW.source_prior_base_commit IS NOT OLD.source_prior_base_commit
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_CHECKPOINT_BINDING_MISMATCH');
END;
`;

type TaskRow = {
  id: string;
  type: string;
  status: string;
  owner_role: string;
  assignee_role: string | null;
  execution_instance_id: string | null;
  writer_generation: number;
  repo_root: string;
  base_commit: string;
  branch: string;
  source_checkpoint_id: string | null;
  source_task_id: string | null;
  source_task_revision: number | null;
  source_checkpoint_commit: string | null;
  source_checkpoint_ref: string | null;
  source_prior_base_commit: string | null;
  payload_json: string;
  result_json: string | null;
  blocker_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: number;
  task_id: string;
  at: string;
  actor_role: string;
  kind: string;
  from_status: string | null;
  to_status: string;
  revision: number;
  detail_json: string | null;
  writer_generation: number;
};

type DispatchRow = {
  id: string;
  task_id: string;
  worker_role: string;
  adapter_id: string;
  worker_profile_id: string | null;
  writer_generation: number;
  runner_instance_id: string | null;
  pid: number | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
};

type CheckpointRow = {
  id: string;
  task_id: string;
  producer_revision: number;
  purpose: string;
  state: string;
  request_identity: string;
  repo_root: string;
  prior_base_commit: string;
  expected_tree: string;
  scope_identity: string;
  checkpoint_commit: string | null;
  checkpoint_ref: string;
  branch: string;
  changed_files_json: string;
  created_at: string;
  finalized_at: string | null;
};

type C2CEvaluationReceiptRow = {
  message_id: string;
  message_digest: string;
  task_id: string;
  evaluated_revision: number;
  decision: string;
  created_at: string;
};

type PlanAcceptanceProjectionRow = {
  command_id: string;
  evaluation_message_id: string;
  accepted_at: string;
  task_id: string;
  accepted_revision: number;
};

type C2CDelegationProjectionRow = {
  command_id: string;
  acceptance_command_id: string;
  dispatch_run_id: string;
  launch_spec_json: string;
  created_at: string;
  task_id: string;
  accepted_revision: number;
  worker_profile_id: string;
  adapter_id: string;
  dispatch_status: string;
};

export type NewTaskEvent = {
  task_id: string;
  at: string;
  actor_role: Role;
  kind: EventKind;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  revision: number;
  detail?: Record<string, unknown> | null;
};

function pragmaValue(db: DatabaseSync, name: string): string | number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, string | number> | undefined;
  if (!row) {
    throw new DomainError('SCHEMA_MISMATCH', `PRAGMA ${name} returned no row`);
  }
  const values = Object.values(row);
  const value = values[0];
  if (value === undefined) {
    throw new DomainError('SCHEMA_MISMATCH', `PRAGMA ${name} returned an empty row`);
  }
  return value;
}

function parseJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function rowToTask(row: TaskRow): TaskContract {
  const payload = taskPayloadSchema.parse(parseJson(row.payload_json));
  const resultRaw = parseJson(row.result_json);
  const blockerRaw = parseJson(row.blocker_json);
  return taskContractSchema.parse({
    id: row.id,
    type: row.type,
    status: row.status,
    owner_role: row.owner_role,
    assignee_role: row.assignee_role,
    execution_instance_id: row.execution_instance_id,
    writer_generation: row.writer_generation,
    repo_root: row.repo_root,
    base_commit: row.base_commit,
    branch: row.branch,
    source_checkpoint:
      row.source_checkpoint_id === null
        ? null
        : {
            checkpoint_id: row.source_checkpoint_id,
            producer_task_id: row.source_task_id,
            producer_revision: row.source_task_revision,
            checkpoint_commit: row.source_checkpoint_commit,
            checkpoint_ref: row.source_checkpoint_ref,
            prior_base_commit: row.source_prior_base_commit,
          },
    payload,
    result: resultRaw === null ? null : taskResultSchema.parse(resultRaw),
    blocker: blockerRaw === null ? null : blockerSchema.parse(blockerRaw),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function rowToEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    at: row.at,
    actor_role: roleSchema.parse(row.actor_role),
    kind: eventKindSchema.parse(row.kind),
    from_status: row.from_status === null ? null : taskStatusSchema.parse(row.from_status),
    to_status: taskStatusSchema.parse(row.to_status),
    revision: row.revision,
    detail: row.detail_json === null ? null : (JSON.parse(row.detail_json) as Record<string, unknown>),
  };
}

function rowToDispatch(row: DispatchRow): DispatchRun {
  return {
    id: row.id,
    task_id: row.task_id,
    worker_role: 'JUNIOR',
    adapter_id: row.adapter_id,
    worker_profile_id: row.worker_profile_id,
    runner_instance_id: row.runner_instance_id,
    pid: row.pid,
    status: row.status as DispatchRun['status'],
    started_at: row.started_at,
    finished_at: row.finished_at,
    exit_code: row.exit_code,
    error_code: row.error_code,
    error_detail: row.error_detail,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToCheckpointIntent(row: CheckpointRow): CheckpointIntent {
  return {
    id: row.id,
    task_id: row.task_id,
    producer_revision: row.producer_revision,
    purpose: checkpointPurposeSchema.parse(row.purpose),
    state: checkpointStateSchema.parse(row.state),
    request_identity: row.request_identity,
    repo_root: row.repo_root,
    prior_base_commit: row.prior_base_commit,
    expected_tree: row.expected_tree,
    scope_identity: row.scope_identity,
    checkpoint_commit: row.checkpoint_commit,
    checkpoint_ref: row.checkpoint_ref,
    branch: row.branch,
    changed_files: JSON.parse(row.changed_files_json) as string[],
    created_at: row.created_at,
    finalized_at: row.finalized_at,
  };
}

function rowToC2CEvaluationReceipt(
  row: C2CEvaluationReceiptRow,
): DurableC2CEvaluationReceipt {
  return durableC2CEvaluationReceiptSchema.parse({
    message_id: row.message_id,
    message_digest: row.message_digest,
    task_id: row.task_id,
    evaluated_revision: row.evaluated_revision,
    decision: row.decision,
    created_at: row.created_at,
  });
}

function rowToPlanAcceptanceReceipt(
  row: PlanAcceptanceProjectionRow,
): PlanAcceptanceReceipt {
  return planAcceptanceReceiptSchema.parse({
    command_id: row.command_id,
    evaluation_message_id: row.evaluation_message_id,
    task_id: row.task_id,
    accepted_revision: row.accepted_revision,
    accepted_at: row.accepted_at,
  });
}

function rowToC2CDelegationIntentReceipt(
  row: C2CDelegationProjectionRow,
): C2CDelegationIntentReceipt {
  return c2cDelegationIntentReceiptSchema.parse({
    command_id: row.command_id,
    acceptance_command_id: row.acceptance_command_id,
    dispatch_run_id: row.dispatch_run_id,
    task_id: row.task_id,
    accepted_revision: row.accepted_revision,
    worker_profile_id: row.worker_profile_id,
    adapter_id: row.adapter_id,
    dispatch_status: row.dispatch_status,
    launch_spec: JSON.parse(row.launch_spec_json) as unknown,
    created_at: row.created_at,
  });
}

function finalizedCheckpoint(intent: CheckpointIntent): TaskCheckpoint {
  return taskCheckpointSchema.parse(intent);
}

function createCheckpointTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      producer_revision INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      state TEXT NOT NULL,
      request_identity TEXT NOT NULL UNIQUE,
      repo_root TEXT NOT NULL,
      prior_base_commit TEXT NOT NULL,
      expected_tree TEXT NOT NULL,
      scope_identity TEXT NOT NULL,
      checkpoint_commit TEXT UNIQUE,
      checkpoint_ref TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE (task_id, producer_revision),
      CHECK (purpose IN ('RESUME','REVIEW')),
      CHECK (state IN ('PREPARED','GIT_APPLIED','FINALIZING','FINALIZED')),
      CHECK ((state IN ('PREPARED','GIT_APPLIED') AND checkpoint_commit IS NULL AND finalized_at IS NULL)
          OR (state = 'FINALIZING' AND checkpoint_commit IS NOT NULL AND finalized_at IS NULL)
          OR (state = 'FINALIZED' AND checkpoint_commit IS NOT NULL AND finalized_at IS NOT NULL)),
      CHECK (producer_revision >= 1)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_checkpoint
    ON task_checkpoints((1))
    WHERE state != 'FINALIZED';
  `);
}

function createC2CEvaluationReceiptTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS c2c_evaluation_receipts (
      message_id TEXT PRIMARY KEY,
      message_digest TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      evaluated_revision INTEGER NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (length(message_digest) = 64),
      CHECK (evaluated_revision >= 1),
      CHECK (decision IN ('REQUIRES_OWNER_ACTION','READY_FOR_REVIEW'))
    ) STRICT;
  `);
}

function createC2CPlanAcceptanceReceiptTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS c2c_plan_acceptance_receipts (
      command_id TEXT PRIMARY KEY,
      evaluation_message_id TEXT NOT NULL UNIQUE REFERENCES c2c_evaluation_receipts(message_id),
      accepted_at TEXT NOT NULL
    ) STRICT;
  `);
}

function createC2CDelegationReceiptTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS c2c_delegation_receipts (
      command_id TEXT PRIMARY KEY,
      acceptance_command_id TEXT NOT NULL UNIQUE REFERENCES c2c_plan_acceptance_receipts(command_id),
      dispatch_run_id TEXT NOT NULL UNIQUE REFERENCES dispatch_runs(id),
      launch_spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}

function rebuildTaskEventsForV8(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS trg_task_events_writer_protocol_insert');
  db.exec(`
    ALTER TABLE task_events RENAME TO task_events_pre_v8;
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      at TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      detail_json TEXT,
      writer_generation INTEGER NOT NULL DEFAULT 1,
      CHECK (actor_role IN ('OWNER','JUNIOR','PRINCIPAL')),
      CHECK (kind IN ('created','claimed','result','blocked','resumed','cancelled','closed','checkpointed'))
    ) STRICT;
    INSERT INTO task_events (
      id, task_id, at, actor_role, kind, from_status, to_status, revision, detail_json, writer_generation
    )
    SELECT id, task_id, at, actor_role, kind, from_status, to_status, revision, detail_json, writer_generation
    FROM task_events_pre_v8;
    DROP TABLE task_events_pre_v8;
  `);
}

function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const currentJournal = String(pragmaValue(db, 'journal_mode')).toLowerCase();
  if (currentJournal !== 'wal') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
}

const REQUIRED_FENCING_TRIGGERS = [
  'trg_tasks_execution_invariant_insert',
  'trg_tasks_execution_invariant_update',
  'trg_tasks_repository_invariant_insert',
  'trg_tasks_repository_invariant_update',
  'trg_tasks_running_immutable_update',
  'trg_tasks_writer_protocol_insert',
  'trg_tasks_writer_protocol_update',
  'trg_task_events_writer_protocol_insert',
  'trg_dispatch_runs_writer_protocol_insert',
  'trg_dispatch_runs_writer_protocol_update',
  'trg_tasks_checkpoint_fence_insert',
  'trg_tasks_checkpoint_fence_update',
  'trg_dispatch_runs_checkpoint_fence_insert',
  'trg_dispatch_runs_checkpoint_fence_update',
  'trg_task_checkpoints_exclusive_insert',
  'trg_task_checkpoints_single_unfinished_insert',
  'trg_tasks_review_source_insert',
  'trg_tasks_review_source_update',
] as const;

const REQUIRED_FENCING_INDEXES = ['one_unfinished_checkpoint'] as const;

function triggerExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function createAllFencingTriggers(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_tasks_execution_invariant_insert
    BEFORE INSERT ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
      WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
         OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_execution_invariant_update
    BEFORE UPDATE ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION')
      WHERE (NEW.status = 'RUNNING' AND NEW.execution_instance_id IS NULL)
         OR (NEW.status != 'RUNNING' AND NEW.execution_instance_id IS NOT NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_repository_invariant_insert
    BEFORE INSERT ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
      WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
         OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_repository_invariant_update
    BEFORE UPDATE ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'REPOSITORY_BINDING_MISMATCH')
      WHERE NOT EXISTS (SELECT 1 FROM ledger_metadata WHERE key = 'repository_root')
         OR NEW.repo_root != (SELECT value FROM ledger_metadata WHERE key = 'repository_root');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_running_immutable_update
    BEFORE UPDATE ON tasks
    WHEN OLD.status = 'RUNNING' AND NEW.status = 'RUNNING'
    BEGIN
      SELECT RAISE(ABORT, 'EXECUTION_STATE_INVARIANT_VIOLATION');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_writer_protocol_insert
    BEFORE INSERT ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_writer_protocol_update
    BEFORE UPDATE ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != OLD.writer_generation + ${WRITER_PROTOCOL_GENERATION};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_task_events_writer_protocol_insert
    BEFORE INSERT ON task_events
    BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dispatch_runs_writer_protocol_insert
    BEFORE INSERT ON dispatch_runs
    BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != ${WRITER_PROTOCOL_GENERATION};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dispatch_runs_writer_protocol_update
    BEFORE UPDATE ON dispatch_runs
    BEGIN
      SELECT RAISE(ABORT, 'CURRENT_PROTOCOL_WRITER_REQUIRED')
      WHERE NEW.writer_generation IS NULL
     OR NEW.writer_generation != OLD.writer_generation + ${WRITER_PROTOCOL_GENERATION};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_checkpoint_fence_update
    BEFORE UPDATE ON tasks
    WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
      FROM task_checkpoints c
      WHERE c.state != 'FINALIZED' AND NOT EXISTS (
        SELECT 1 FROM task_checkpoints c
        WHERE c.task_id = OLD.id AND c.state = 'FINALIZING'
          AND OLD.revision = c.producer_revision AND NEW.revision = c.producer_revision + 1
          AND NEW.base_commit = c.checkpoint_commit AND NEW.status = OLD.status
          AND NEW.assignee_role IS OLD.assignee_role
          AND NEW.execution_instance_id IS OLD.execution_instance_id
          AND NEW.type = OLD.type AND NEW.owner_role = OLD.owner_role
          AND NEW.repo_root = OLD.repo_root AND NEW.branch = OLD.branch
          AND NEW.payload_json = OLD.payload_json
          AND NEW.result_json IS OLD.result_json AND NEW.blocker_json IS OLD.blocker_json
          AND NEW.source_checkpoint_id IS OLD.source_checkpoint_id
          AND NEW.source_task_id IS OLD.source_task_id
          AND NEW.source_task_revision IS OLD.source_task_revision
          AND NEW.source_checkpoint_commit IS OLD.source_checkpoint_commit
          AND NEW.source_checkpoint_ref IS OLD.source_checkpoint_ref
          AND NEW.source_prior_base_commit IS OLD.source_prior_base_commit
          AND NEW.created_at = OLD.created_at
      ) LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_checkpoint_fence_insert
    BEFORE INSERT ON tasks
    WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
      FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dispatch_runs_checkpoint_fence_insert
    BEFORE INSERT ON dispatch_runs
    WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
      FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dispatch_runs_checkpoint_fence_update
    BEFORE UPDATE ON dispatch_runs
    WHEN EXISTS (SELECT 1 FROM task_checkpoints c WHERE c.state != 'FINALIZED')
    BEGIN
      SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
      FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_task_checkpoints_exclusive_insert
    BEFORE INSERT ON task_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'TASK_ALREADY_RUNNING task=' || t.id)
      FROM tasks t WHERE t.status = 'RUNNING' LIMIT 1;
      SELECT RAISE(ABORT, 'CHECKPOINT_ACTIVE_DISPATCH dispatch=' || d.id || ' task=' || d.task_id)
      FROM dispatch_runs d WHERE d.status IN ('launching','running') LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_task_checkpoints_single_unfinished_insert
    BEFORE INSERT ON task_checkpoints
    WHEN NEW.state != 'FINALIZED'
    BEGIN
      SELECT RAISE(ABORT, 'CHECKPOINT_FINALIZATION_REQUIRED task=' || c.task_id || ' checkpoint=' || c.id || ' state=' || c.state)
      FROM task_checkpoints c WHERE c.state != 'FINALIZED' LIMIT 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_review_source_insert
    BEFORE INSERT ON tasks
    WHEN NEW.source_checkpoint_id IS NOT NULL OR NEW.source_task_id IS NOT NULL
      OR NEW.source_task_revision IS NOT NULL OR NEW.source_checkpoint_commit IS NOT NULL
      OR NEW.source_checkpoint_ref IS NOT NULL OR NEW.source_prior_base_commit IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'REVIEW_CHECKPOINT_BINDING_MISMATCH')
      WHERE NEW.type != 'DIAGNOSIS' OR NOT EXISTS (
        SELECT 1 FROM task_checkpoints c
        WHERE c.id = NEW.source_checkpoint_id AND c.state = 'FINALIZED' AND c.purpose = 'REVIEW'
          AND c.task_id = NEW.source_task_id AND c.producer_revision = NEW.source_task_revision
          AND c.checkpoint_commit = NEW.source_checkpoint_commit AND c.checkpoint_ref = NEW.source_checkpoint_ref
          AND c.prior_base_commit = NEW.source_prior_base_commit
          AND NEW.base_commit = c.checkpoint_commit AND NEW.repo_root = c.repo_root AND NEW.branch = c.branch
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_review_source_update
    BEFORE UPDATE ON tasks
    WHEN NEW.source_checkpoint_id IS NOT OLD.source_checkpoint_id
      OR NEW.source_task_id IS NOT OLD.source_task_id
      OR NEW.source_task_revision IS NOT OLD.source_task_revision
      OR NEW.source_checkpoint_commit IS NOT OLD.source_checkpoint_commit
      OR NEW.source_checkpoint_ref IS NOT OLD.source_checkpoint_ref
      OR NEW.source_prior_base_commit IS NOT OLD.source_prior_base_commit
    BEGIN
      SELECT RAISE(ABORT, 'REVIEW_CHECKPOINT_BINDING_MISMATCH');
    END;
  `);
}

function reinstallCurrentWriterProtocolTriggers(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_update');
  db.exec('DROP TRIGGER IF EXISTS trg_task_events_writer_protocol_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_update');
  createAllFencingTriggers(db);
}

function indexExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function validateExecutionInvariantRows(db: DatabaseSync): void {
  const runningWithoutOwner = db
    .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE status = 'RUNNING' AND execution_instance_id IS NULL`)
    .get() as { count: number };
  if (runningWithoutOwner.count > 0) {
    throw new DomainError(
      'LEGACY_RUNNING_TASK_PREVENTS_MIGRATION',
      'A legacy RUNNING task with no execution_instance_id exists; resolve or stop it under the old version before migration',
      { running_without_owner_count: runningWithoutOwner.count },
    );
  }

  const nonRunningWithOwner = db
    .prepare(
      `SELECT COUNT(*) AS count FROM tasks WHERE status != 'RUNNING' AND execution_instance_id IS NOT NULL`,
    )
    .get() as { count: number };
  if (nonRunningWithOwner.count > 0) {
    throw new DomainError(
      'EXECUTION_STATE_INVARIANT_VIOLATION',
      'Existing task data violates the execution ownership invariant',
      { non_running_with_owner_count: nonRunningWithOwner.count },
    );
  }
}

function validateWriterGenerationRows(db: DatabaseSync): void {
  const missing = db
    .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE writer_generation IS NULL`)
    .get() as { count: number };
  if (missing.count > 0) {
    throw new DomainError(
      'SCHEMA_FENCING_MISSING',
      'Existing task rows are missing the current-protocol writer generation',
      { missing_writer_generation_count: missing.count },
    );
  }
}

function validateTaskRepositoryRoots(db: DatabaseSync): void {
  const row = db
    .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
    .get() as { value: string } | undefined;
  if (!row) {
    throw new DomainError(
      'REPOSITORY_BINDING_MISMATCH',
      'Ledger metadata has no repository_root; refusing to validate task roots',
    );
  }
  const bad = db
    .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE repo_root != ?`)
    .get(row.value) as { count: number };
  if (bad.count > 0) {
    throw new DomainError(
      'REPOSITORY_BINDING_MISMATCH',
      `Ledger contains tasks whose repo_root does not match bound repository ${row.value}`,
      { repository_root: row.value, foreign_task_count: bad.count },
    );
  }
}

function validateFencingObjects(db: DatabaseSync): void {
  for (const name of REQUIRED_FENCING_TRIGGERS) {
    if (!triggerExists(db, name)) {
      throw new DomainError(
        'SCHEMA_FENCING_MISSING',
        `Required execution fencing trigger ${name} is missing`,
        { trigger: name },
      );
    }
  }
  for (const name of REQUIRED_FENCING_INDEXES) {
    if (!indexExists(db, name)) {
      throw new DomainError(
        'SCHEMA_FENCING_MISSING',
        `Required checkpoint fencing index ${name} is missing`,
        { index: name },
      );
    }
  }
}

function validateC2CEvaluationReceiptStorage(db: DatabaseSync): void {
  if (!tableExists(db, 'c2c_evaluation_receipts')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C evaluation receipt table is missing',
    );
  }

  const columns = db
    .prepare(`PRAGMA table_info(c2c_evaluation_receipts)`)
    .all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  const expected = [
    'message_id',
    'message_digest',
    'task_id',
    'evaluated_revision',
    'decision',
    'created_at',
  ];
  if (
    names.length !== expected.length ||
    expected.some((name, index) => names[index] !== name)
  ) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C evaluation receipt table has an unexpected shape',
      { actual_columns: names, expected_columns: expected },
    );
  }

  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'c2c_evaluation_receipts'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql.toUpperCase().includes('STRICT')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C evaluation receipt table must be STRICT',
    );
  }
}

function validateC2CPlanAcceptanceStorage(db: DatabaseSync): void {
  if (!tableExists(db, 'c2c_plan_acceptance_receipts')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C plan acceptance receipt table is missing',
    );
  }

  const columns = db
    .prepare(`PRAGMA table_info(c2c_plan_acceptance_receipts)`)
    .all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  const expected = ['command_id', 'evaluation_message_id', 'accepted_at'];
  if (
    names.length !== expected.length ||
    expected.some((name, index) => names[index] !== name)
  ) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C plan acceptance receipt table has an unexpected shape',
      { actual_columns: names, expected_columns: expected },
    );
  }

  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'c2c_plan_acceptance_receipts'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql.toUpperCase().includes('STRICT')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C plan acceptance receipt table must be STRICT',
    );
  }
}

function validateC2CDelegationStorage(db: DatabaseSync): void {
  if (!tableExists(db, 'c2c_delegation_receipts')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C delegation receipt table is missing',
    );
  }

  const columns = db
    .prepare(`PRAGMA table_info(c2c_delegation_receipts)`)
    .all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  const expected = [
    'command_id',
    'acceptance_command_id',
    'dispatch_run_id',
    'launch_spec_json',
    'created_at',
  ];
  if (
    names.length !== expected.length ||
    expected.some((name, index) => names[index] !== name)
  ) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C delegation receipt table has an unexpected shape',
      { actual_columns: names, expected_columns: expected },
    );
  }

  const table = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'c2c_delegation_receipts'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql.toUpperCase().includes('STRICT')) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      'C2C delegation receipt table must be STRICT',
    );
  }
}

function migrateAndValidate(db: DatabaseSync, repoRoot?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read the schema version while holding the write lock so a concurrent
    // v0 -> current migration is observed before choosing the migration path.
    const userVersion = Number(pragmaValue(db, 'user_version'));

    if (userVersion === 0) {
      db.exec(CREATE_SCHEMA_SQL);
      createAllFencingTriggers(db);
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (
      userVersion === 1 ||
      userVersion === 2 ||
      userVersion === 3 ||
      userVersion === 4 ||
      userVersion === 5 ||
      userVersion === 6 ||
      userVersion === 7
    ) {
      if (userVersion === 1) {
        const running = db
          .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE status = 'RUNNING'`)
          .get() as { count: number };
        if (running.count > 0) {
          throw new DomainError(
            'LEGACY_RUNNING_TASK_PREVENTS_MIGRATION',
            'A legacy RUNNING task exists; resolve or stop it under the old version before migration',
            { running_count: running.count },
          );
        }
      }

      if (!columnExists(db, 'tasks', 'execution_instance_id')) {
        db.exec('ALTER TABLE tasks ADD COLUMN execution_instance_id TEXT');
      }
      if (!tableExists(db, 'ledger_metadata')) {
        db.exec(`
          CREATE TABLE ledger_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
        `);
      }
      if (!tableExists(db, 'dispatch_runs')) {
        db.exec(`
          CREATE TABLE dispatch_runs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            worker_role TEXT NOT NULL,
            adapter_id TEXT NOT NULL,
            worker_profile_id TEXT,
            writer_generation INTEGER NOT NULL DEFAULT 1,
            runner_instance_id TEXT,
            pid INTEGER,
            status TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            exit_code INTEGER,
            error_code TEXT,
            error_detail TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (worker_role IN ('JUNIOR')),
            CHECK (status IN ('launching','running','completed','blocked','failed'))
          ) STRICT;
          CREATE UNIQUE INDEX one_active_dispatch_per_task
          ON dispatch_runs(task_id)
          WHERE status IN ('launching','running');
        `);
      }
      if (!columnExists(db, 'dispatch_runs', 'worker_profile_id')) {
        db.exec('ALTER TABLE dispatch_runs ADD COLUMN worker_profile_id TEXT');
      }
      if (!columnExists(db, 'dispatch_runs', 'writer_generation')) {
        db.exec('ALTER TABLE dispatch_runs ADD COLUMN writer_generation INTEGER NOT NULL DEFAULT 1');
      }
      if (!columnExists(db, 'task_events', 'writer_generation')) {
        db.exec('ALTER TABLE task_events ADD COLUMN writer_generation INTEGER NOT NULL DEFAULT 1');
      }

      const metadata = db
        .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
        .get() as { value: string } | undefined;
      if (!metadata) {
        if (repoRoot === undefined) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'Cannot migrate an unbound legacy ledger without a canonical repository root',
          );
        }
        requireRepositoryBinding(db, repoRoot);
      } else if (repoRoot !== undefined && metadata.value !== repoRoot) {
        throw new DomainError(
          'REPOSITORY_BINDING_MISMATCH',
          `Ledger is bound to repository ${metadata.value}; refusing to migrate from ${repoRoot}`,
          { expected: metadata.value, actual: repoRoot },
        );
      }

      if (!columnExists(db, 'tasks', 'writer_generation')) {
        db.exec('ALTER TABLE tasks ADD COLUMN writer_generation INTEGER');
      }
      if (!columnExists(db, 'tasks', 'source_checkpoint_id')) {
        db.exec('ALTER TABLE tasks ADD COLUMN source_checkpoint_id TEXT');
        db.exec('ALTER TABLE tasks ADD COLUMN source_task_id TEXT');
        db.exec('ALTER TABLE tasks ADD COLUMN source_task_revision INTEGER');
        db.exec('ALTER TABLE tasks ADD COLUMN source_checkpoint_commit TEXT');
        db.exec('ALTER TABLE tasks ADD COLUMN source_checkpoint_ref TEXT');
        db.exec('ALTER TABLE tasks ADD COLUMN source_prior_base_commit TEXT');
      }
      createCheckpointTable(db);
      createC2CEvaluationReceiptTable(db);
      createC2CPlanAcceptanceReceiptTable(db);
      createC2CDelegationReceiptTable(db);
      db.exec(`UPDATE tasks SET writer_generation = 1 WHERE writer_generation IS NULL`);

      validateExecutionInvariantRows(db);
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
      rebuildTaskEventsForV8(db);
      // Reinstall the current writer fences after rebuilding task_events.
      db.exec('DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_insert');
      db.exec('DROP TRIGGER IF EXISTS trg_tasks_writer_protocol_update');
      db.exec('DROP TRIGGER IF EXISTS trg_task_events_writer_protocol_insert');
      db.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_insert');
      db.exec('DROP TRIGGER IF EXISTS trg_dispatch_runs_writer_protocol_update');
      createAllFencingTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (userVersion === 8) {
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      } else {
        const metadata = db
          .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
          .get() as { value: string } | undefined;
        if (!metadata) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'V8 ledger is missing repository binding metadata',
          );
        }
      }
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
      createC2CEvaluationReceiptTable(db);
      createC2CPlanAcceptanceReceiptTable(db);
      createC2CDelegationReceiptTable(db);
      reinstallCurrentWriterProtocolTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (userVersion === 9) {
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      } else {
        const metadata = db
          .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
          .get() as { value: string } | undefined;
        if (!metadata) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'V9 ledger is missing repository binding metadata',
          );
        }
      }
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
      validateC2CEvaluationReceiptStorage(db);
      createC2CPlanAcceptanceReceiptTable(db);
      createC2CDelegationReceiptTable(db);
      reinstallCurrentWriterProtocolTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (userVersion === 10) {
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      } else {
        const metadata = db
          .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
          .get() as { value: string } | undefined;
        if (!metadata) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'V10 ledger is missing repository binding metadata',
          );
        }
      }
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
      validateC2CEvaluationReceiptStorage(db);
      validateC2CPlanAcceptanceStorage(db);
      createC2CDelegationReceiptTable(db);
      reinstallCurrentWriterProtocolTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (userVersion === 11) {
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      } else {
        const metadata = db
          .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
          .get() as { value: string } | undefined;
        if (!metadata) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'V11 ledger is missing repository binding metadata',
          );
        }
      }
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
      validateC2CEvaluationReceiptStorage(db);
      validateC2CPlanAcceptanceStorage(db);
      validateC2CDelegationStorage(db);
      reinstallCurrentWriterProtocolTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (userVersion === SCHEMA_VERSION) {
      if (repoRoot !== undefined) {
        requireRepositoryBinding(db, repoRoot);
      } else {
        const metadata = db
          .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
          .get() as { value: string } | undefined;
        if (!metadata) {
          throw new DomainError(
            'REPOSITORY_BINDING_MISMATCH',
            'Current schema ledger is missing repository binding metadata',
          );
        }
      }
      validateTaskRepositoryRoots(db);
      validateWriterGenerationRows(db);
    } else {
      throw new DomainError(
        'SCHEMA_MISMATCH',
        `Unsupported schema user_version ${userVersion}; expected ${SCHEMA_VERSION}`,
        { actual: userVersion, expected: SCHEMA_VERSION },
      );
    }

    validateC2CEvaluationReceiptStorage(db);
    validateC2CPlanAcceptanceStorage(db);
    validateC2CDelegationStorage(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }

  const journalMode = String(pragmaValue(db, 'journal_mode')).toLowerCase();
  if (journalMode !== 'wal') {
    throw new DomainError('SCHEMA_MISMATCH', `Expected WAL journal_mode, found ${journalMode}`);
  }
  const foreignKeys = Number(pragmaValue(db, 'foreign_keys'));
  if (foreignKeys !== 1) {
    throw new DomainError('SCHEMA_MISMATCH', 'Foreign keys are not enabled');
  }
  const validatedVersion = Number(pragmaValue(db, 'user_version'));
  if (validatedVersion !== SCHEMA_VERSION) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      `Schema user_version was not ${SCHEMA_VERSION} after open`,
      { actual: validatedVersion },
    );
  }

  const names = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'task_events', 'ledger_metadata', 'dispatch_runs', 'task_checkpoints', 'c2c_evaluation_receipts', 'c2c_plan_acceptance_receipts', 'c2c_delegation_receipts')`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (
    !names.has('tasks') ||
    !names.has('task_events') ||
    !names.has('ledger_metadata') ||
    !names.has('dispatch_runs') ||
    !names.has('task_checkpoints') ||
    !names.has('c2c_evaluation_receipts') ||
    !names.has('c2c_plan_acceptance_receipts') ||
    !names.has('c2c_delegation_receipts')
  ) {
    throw new DomainError('SCHEMA_MISMATCH', 'Required tables are missing');
  }
  validateFencingObjects(db);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function requireRepositoryBinding(db: DatabaseSync, repoRoot: string): void {
  const row = db
    .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
    .get() as { value: string } | undefined;
  if (row) {
    if (row.value !== repoRoot) {
      throw new DomainError(
        'REPOSITORY_BINDING_MISMATCH',
        `Ledger is bound to repository ${row.value}; refusing to open from ${repoRoot}`,
        { expected: row.value, actual: repoRoot },
      );
    }
    return;
  }

  const repoRows = db.prepare(`SELECT DISTINCT repo_root FROM tasks`).all() as Array<{
    repo_root: string;
  }>;
  if (repoRows.length === 0) {
    db.prepare(`INSERT INTO ledger_metadata (key, value) VALUES ('repository_root', ?)`).run(repoRoot);
    return;
  }
  if (repoRows.length === 1 && repoRows[0]?.repo_root === repoRoot) {
    db.prepare(`INSERT INTO ledger_metadata (key, value) VALUES ('repository_root', ?)`).run(repoRoot);
    return;
  }
  if (repoRows.length === 1) {
    throw new DomainError(
      'REPOSITORY_BINDING_MISMATCH',
      `Ledger contains tasks for repository ${repoRows[0]?.repo_root}; refusing to bind to ${repoRoot}`,
      { task_repo_root: repoRows[0]?.repo_root, requested_repo_root: repoRoot },
    );
  }
  throw new DomainError(
    'REPOSITORY_BINDING_MISMATCH',
    'Ledger contains tasks from multiple repositories; refusing to infer repository binding',
    { requested_repo_root: repoRoot },
  );
}

export class Store {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  private boundRepoRoot: string | undefined;

  private constructor(path: string, db: DatabaseSync, boundRepoRoot?: string) {
    this.path = path;
    this.db = db;
    this.boundRepoRoot = boundRepoRoot;
  }

  static open(path: string, options?: { repoRoot?: string }): Store {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, {
      timeout: BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
    try {
      applyConnectionPragmas(db);
      migrateAndValidate(db, options?.repoRoot);
      return new Store(path, db, options?.repoRoot);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  bindRepository(repoRoot: string): void {
    if (this.closed) {
      throw new DomainError('SCHEMA_MISMATCH', 'Cannot bind a closed Store');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      requireRepositoryBinding(this.db, repoRoot);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
    this.boundRepoRoot = repoRoot;
  }

  get repositoryRoot(): string | undefined {
    return this.boundRepoRoot;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  transact<T>(fn: () => T, beforeCommit?: () => void): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      beforeCommit?.();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  getTask(id: string): TaskContract | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listActive(type?: TaskType): TaskContract[] {
    const rows = (
      type
        ? (this.db
            .prepare(
              `SELECT * FROM tasks WHERE status != 'CLOSED' AND type = ? ORDER BY created_at ASC, rowid ASC`,
            )
            .all(type) as TaskRow[])
        : (this.db
            .prepare(
              `SELECT * FROM tasks WHERE status != 'CLOSED' ORDER BY created_at ASC, rowid ASC`,
            )
            .all() as TaskRow[])
    );
    return rows.map(rowToTask);
  }

  getRunning(): TaskContract | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE status = 'RUNNING' LIMIT 1`).get() as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getNextReady(type: TaskType): TaskContract | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'READY' AND type = ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get(type) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getNextReadyUnreserved(type: TaskType): TaskContract | undefined {
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'READY' AND t.type = ?
           AND NOT EXISTS (
             SELECT 1
             FROM c2c_delegation_receipts d
             JOIN dispatch_runs r ON r.id = d.dispatch_run_id
             WHERE r.task_id = t.id
               AND r.status IN ('launching','running')
           )
         ORDER BY t.created_at ASC, t.rowid ASC
         LIMIT 1`,
      )
      .get(type) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  insertTask(task: TaskContract): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, type, status, owner_role, assignee_role, execution_instance_id,
          writer_generation, repo_root, base_commit, branch, source_checkpoint_id,
          source_task_id, source_task_revision, source_checkpoint_commit, source_checkpoint_ref,
          source_prior_base_commit, payload_json, result_json, blocker_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.type,
        task.status,
        task.owner_role,
        task.assignee_role,
        task.execution_instance_id,
        task.writer_generation,
        task.repo_root,
        task.base_commit,
        task.branch,
        task.source_checkpoint?.checkpoint_id ?? null,
        task.source_checkpoint?.producer_task_id ?? null,
        task.source_checkpoint?.producer_revision ?? null,
        task.source_checkpoint?.checkpoint_commit ?? null,
        task.source_checkpoint?.checkpoint_ref ?? null,
        task.source_checkpoint?.prior_base_commit ?? null,
        JSON.stringify(task.payload),
        task.result === null ? null : JSON.stringify(task.result),
        task.blocker === null ? null : JSON.stringify(task.blocker),
        task.revision,
        task.created_at,
        task.updated_at,
      );
  }

  updateTask(task: TaskContract): void {
    const result = this.db
      .prepare(
        `UPDATE tasks SET
          type = ?, status = ?, owner_role = ?, assignee_role = ?, execution_instance_id = ?,
          writer_generation = ?, repo_root = ?, base_commit = ?, branch = ?, payload_json = ?,
          result_json = ?, blocker_json = ?, revision = ?, created_at = ?, updated_at = ?,
          source_checkpoint_id = ?, source_task_id = ?, source_task_revision = ?,
          source_checkpoint_commit = ?, source_checkpoint_ref = ?, source_prior_base_commit = ?
         WHERE id = ?`,
      )
      .run(
        task.type,
        task.status,
        task.owner_role,
        task.assignee_role,
        task.execution_instance_id,
        task.writer_generation,
        task.repo_root,
        task.base_commit,
        task.branch,
        JSON.stringify(task.payload),
        task.result === null ? null : JSON.stringify(task.result),
        task.blocker === null ? null : JSON.stringify(task.blocker),
        task.revision,
        task.created_at,
        task.updated_at,
        task.source_checkpoint?.checkpoint_id ?? null,
        task.source_checkpoint?.producer_task_id ?? null,
        task.source_checkpoint?.producer_revision ?? null,
        task.source_checkpoint?.checkpoint_commit ?? null,
        task.source_checkpoint?.checkpoint_ref ?? null,
        task.source_checkpoint?.prior_base_commit ?? null,
        task.id,
      );
    if (result.changes !== 1) {
      throw new DomainError('TASK_NOT_FOUND', `Task ${task.id} was not updated`);
    }
  }

  insertEvent(event: NewTaskEvent): void {
    this.db
      .prepare(
        `INSERT INTO task_events (
          task_id, at, actor_role, kind, from_status, to_status, revision, detail_json, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${WRITER_PROTOCOL_GENERATION})`,
      )
      .run(
        event.task_id,
        event.at,
        event.actor_role,
        event.kind,
        event.from_status,
        event.to_status,
        event.revision,
        event.detail === undefined || event.detail === null ? null : JSON.stringify(event.detail),
      );
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as EventRow[];
    return rows.map(rowToEvent);
  }

  getC2CEvaluationReceipt(messageId: string): DurableC2CEvaluationReceipt | undefined {
    const row = this.db
      .prepare(`SELECT * FROM c2c_evaluation_receipts WHERE message_id = ?`)
      .get(messageId) as C2CEvaluationReceiptRow | undefined;
    return row ? rowToC2CEvaluationReceipt(row) : undefined;
  }

  insertC2CEvaluationReceipt(receipt: DurableC2CEvaluationReceipt): void {
    const parsed = durableC2CEvaluationReceiptSchema.parse(receipt);
    this.db
      .prepare(
        `INSERT INTO c2c_evaluation_receipts (
          message_id, message_digest, task_id, evaluated_revision, decision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.message_id,
        parsed.message_digest,
        parsed.task_id,
        parsed.evaluated_revision,
        parsed.decision,
        parsed.created_at,
      );
  }

  getPlanAcceptanceReceipt(commandId: string): PlanAcceptanceReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT a.command_id, a.evaluation_message_id, a.accepted_at,
                e.task_id, e.evaluated_revision AS accepted_revision
         FROM c2c_plan_acceptance_receipts a
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         WHERE a.command_id = ?`,
      )
      .get(commandId) as PlanAcceptanceProjectionRow | undefined;
    return row ? rowToPlanAcceptanceReceipt(row) : undefined;
  }

  getPlanAcceptanceForEvaluation(
    evaluationMessageId: string,
  ): PlanAcceptanceReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT a.command_id, a.evaluation_message_id, a.accepted_at,
                e.task_id, e.evaluated_revision AS accepted_revision
         FROM c2c_plan_acceptance_receipts a
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         WHERE a.evaluation_message_id = ?`,
      )
      .get(evaluationMessageId) as PlanAcceptanceProjectionRow | undefined;
    return row ? rowToPlanAcceptanceReceipt(row) : undefined;
  }

  insertPlanAcceptanceReceipt(row: NormalizedPlanAcceptanceRow): void {
    const parsed = normalizedPlanAcceptanceRowSchema.parse(row);
    this.db
      .prepare(
        `INSERT INTO c2c_plan_acceptance_receipts (
          command_id, evaluation_message_id, accepted_at
        ) VALUES (?, ?, ?)`,
      )
      .run(
        parsed.command_id,
        parsed.evaluation_message_id,
        parsed.accepted_at,
      );
  }

  getC2CDelegationIntentReceipt(
    commandId: string,
  ): C2CDelegationIntentReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT d.command_id, d.acceptance_command_id, d.dispatch_run_id,
                d.launch_spec_json, d.created_at,
                e.task_id, e.evaluated_revision AS accepted_revision,
                r.worker_profile_id, r.adapter_id, r.status AS dispatch_status
         FROM c2c_delegation_receipts d
         JOIN c2c_plan_acceptance_receipts a
           ON a.command_id = d.acceptance_command_id
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         JOIN dispatch_runs r
           ON r.id = d.dispatch_run_id
         WHERE d.command_id = ?`,
      )
      .get(commandId) as C2CDelegationProjectionRow | undefined;
    return row ? rowToC2CDelegationIntentReceipt(row) : undefined;
  }

  getC2CDelegationIntentForAcceptance(
    acceptanceCommandId: string,
  ): C2CDelegationIntentReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT d.command_id, d.acceptance_command_id, d.dispatch_run_id,
                d.launch_spec_json, d.created_at,
                e.task_id, e.evaluated_revision AS accepted_revision,
                r.worker_profile_id, r.adapter_id, r.status AS dispatch_status
         FROM c2c_delegation_receipts d
         JOIN c2c_plan_acceptance_receipts a
           ON a.command_id = d.acceptance_command_id
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         JOIN dispatch_runs r
           ON r.id = d.dispatch_run_id
         WHERE d.acceptance_command_id = ?`,
      )
      .get(acceptanceCommandId) as C2CDelegationProjectionRow | undefined;
    return row ? rowToC2CDelegationIntentReceipt(row) : undefined;
  }

  getC2CDelegationIntentForDispatch(
    dispatchRunId: string,
  ): C2CDelegationIntentReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT d.command_id, d.acceptance_command_id, d.dispatch_run_id,
                d.launch_spec_json, d.created_at,
                e.task_id, e.evaluated_revision AS accepted_revision,
                r.worker_profile_id, r.adapter_id, r.status AS dispatch_status
         FROM c2c_delegation_receipts d
         JOIN c2c_plan_acceptance_receipts a
           ON a.command_id = d.acceptance_command_id
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         JOIN dispatch_runs r
           ON r.id = d.dispatch_run_id
         WHERE d.dispatch_run_id = ?`,
      )
      .get(dispatchRunId) as C2CDelegationProjectionRow | undefined;
    return row ? rowToC2CDelegationIntentReceipt(row) : undefined;
  }

  getActiveC2CDelegationIntentForTask(
    taskId: string,
  ): C2CDelegationIntentReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT d.command_id, d.acceptance_command_id, d.dispatch_run_id,
                d.launch_spec_json, d.created_at,
                e.task_id, e.evaluated_revision AS accepted_revision,
                r.worker_profile_id, r.adapter_id, r.status AS dispatch_status
         FROM c2c_delegation_receipts d
         JOIN c2c_plan_acceptance_receipts a
           ON a.command_id = d.acceptance_command_id
         JOIN c2c_evaluation_receipts e
           ON e.message_id = a.evaluation_message_id
         JOIN dispatch_runs r
           ON r.id = d.dispatch_run_id
         WHERE r.task_id = ?
           AND r.status IN ('launching','running')
         ORDER BY r.created_at ASC
         LIMIT 1`,
      )
      .get(taskId) as C2CDelegationProjectionRow | undefined;
    return row ? rowToC2CDelegationIntentReceipt(row) : undefined;
  }

  insertC2CDelegationIntentReceipt(
    row: NormalizedC2CDelegationReceiptRow,
  ): void {
    const parsed = normalizedC2CDelegationReceiptRowSchema.parse(row);
    this.db
      .prepare(
        `INSERT INTO c2c_delegation_receipts (
          command_id, acceptance_command_id, dispatch_run_id,
          launch_spec_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.command_id,
        parsed.acceptance_command_id,
        parsed.dispatch_run_id,
        JSON.stringify(parsed.launch_spec),
        parsed.created_at,
      );
  }

  insertCheckpointIntent(checkpoint: CheckpointIntent): void {
    this.db
      .prepare(
        `INSERT INTO task_checkpoints (
          id, task_id, producer_revision, purpose, state, request_identity, repo_root,
          prior_base_commit, expected_tree, scope_identity, checkpoint_commit,
          checkpoint_ref, branch, changed_files_json, created_at, finalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.task_id,
        checkpoint.producer_revision,
        checkpoint.purpose,
        checkpoint.state,
        checkpoint.request_identity,
        checkpoint.repo_root,
        checkpoint.prior_base_commit,
        checkpoint.expected_tree,
        checkpoint.scope_identity,
        checkpoint.checkpoint_commit,
        checkpoint.checkpoint_ref,
        checkpoint.branch,
        JSON.stringify(checkpoint.changed_files),
        checkpoint.created_at,
        checkpoint.finalized_at,
      );
  }

  getCheckpointForRevision(taskId: string, producerRevision: number): CheckpointIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE task_id = ? AND producer_revision = ?`,
      )
      .get(taskId, producerRevision) as CheckpointRow | undefined;
    return row ? rowToCheckpointIntent(row) : undefined;
  }

  getCheckpointById(id: string): CheckpointIntent | undefined {
    const row = this.db.prepare(`SELECT * FROM task_checkpoints WHERE id = ?`).get(id) as CheckpointRow | undefined;
    return row ? rowToCheckpointIntent(row) : undefined;
  }

  getUnfinalizedCheckpoint(taskId: string): CheckpointIntent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM task_checkpoints WHERE task_id = ? AND state != 'FINALIZED' LIMIT 1`)
      .get(taskId) as CheckpointRow | undefined;
    return row ? rowToCheckpointIntent(row) : undefined;
  }

  getAnyUnfinalizedCheckpoint(): CheckpointIntent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM task_checkpoints WHERE state != 'FINALIZED' ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get() as CheckpointRow | undefined;
    return row ? rowToCheckpointIntent(row) : undefined;
  }

  setCheckpointState(id: string, state: CheckpointIntent['state'], checkpointCommit?: string, finalizedAt?: string): void {
    const result = this.db
      .prepare(
        `UPDATE task_checkpoints SET state = ?, checkpoint_commit = COALESCE(?, checkpoint_commit),
         finalized_at = ? WHERE id = ?`,
      )
      .run(state, checkpointCommit ?? null, finalizedAt ?? null, id);
    if (result.changes !== 1) throw new DomainError('TASK_NOT_FOUND', `Checkpoint ${id} was not updated`);
  }

  listCheckpoints(taskId: string): TaskCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE task_id = ? AND state = 'FINALIZED' ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId) as CheckpointRow[];
    return rows.map((row) => finalizedCheckpoint(rowToCheckpointIntent(row)));
  }

  insertDispatchRun(run: DispatchRun): void {
    this.db
      .prepare(
        `INSERT INTO dispatch_runs (
          id, task_id, worker_role, adapter_id, worker_profile_id, writer_generation, runner_instance_id, pid, status,
          started_at, finished_at, exit_code, error_code, error_detail, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ${WRITER_PROTOCOL_GENERATION}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.task_id,
        run.worker_role,
        run.adapter_id,
        run.worker_profile_id,
        run.runner_instance_id,
        run.pid,
        run.status,
        run.started_at,
        run.finished_at,
        run.exit_code,
        run.error_code,
        run.error_detail,
        run.created_at,
        run.updated_at,
      );
  }

  updateDispatchRun(run: DispatchRun): void {
    this.db
      .prepare(
        `UPDATE dispatch_runs SET
          worker_role = ?, adapter_id = ?, worker_profile_id = ?, runner_instance_id = ?, pid = ?, status = ?,
          started_at = ?, finished_at = ?, exit_code = ?, error_code = ?, error_detail = ?,
          writer_generation = writer_generation + ${WRITER_PROTOCOL_GENERATION},
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        run.worker_role,
        run.adapter_id,
        run.worker_profile_id,
        run.runner_instance_id,
        run.pid,
        run.status,
        run.started_at,
        run.finished_at,
        run.exit_code,
        run.error_code,
        run.error_detail,
        run.updated_at,
        run.id,
      );
  }

  failActiveDispatchForTask(taskId: string, errorCode: string, errorDetail: string): void {
    const timestamp = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE dispatch_runs
         SET status = 'failed', finished_at = ?, error_code = ?, error_detail = ?,
             writer_generation = writer_generation + ${WRITER_PROTOCOL_GENERATION}, updated_at = ?
         WHERE task_id = ? AND status IN ('launching','running')`,
      )
      .run(timestamp, errorCode, errorDetail, timestamp, taskId);
  }

  getDispatchRun(id: string): DispatchRun | undefined {
    const row = this.db.prepare(`SELECT * FROM dispatch_runs WHERE id = ?`).get(id) as
      | DispatchRow
      | undefined;
    return row ? rowToDispatch(row) : undefined;
  }

  getActiveDispatchForTask(taskId: string): DispatchRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM dispatch_runs
         WHERE task_id = ? AND status IN ('launching','running')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(taskId) as DispatchRow | undefined;
    return row ? rowToDispatch(row) : undefined;
  }

  getActiveDispatch(): DispatchRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM dispatch_runs
         WHERE status IN ('launching','running')
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get() as DispatchRow | undefined;
    return row ? rowToDispatch(row) : undefined;
  }

  listDispatchRunsForTask(taskId: string): DispatchRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM dispatch_runs WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as DispatchRow[];
    return rows.map(rowToDispatch);
  }
}
