import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from './errors.ts';
import {
  BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  blockerSchema,
  eventKindSchema,
  roleSchema,
  taskContractSchema,
  taskPayloadSchema,
  taskResultSchema,
  taskStatusSchema,
  type EventKind,
  type Role,
  type TaskContract,
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
  repo_root TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
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
  CHECK (actor_role IN ('OWNER','JUNIOR','PRINCIPAL')),
  CHECK (kind IN ('created','claimed','result','blocked','resumed','cancelled','closed'))
) STRICT;

CREATE TABLE ledger_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

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
`;

type TaskRow = {
  id: string;
  type: string;
  status: string;
  owner_role: string;
  assignee_role: string | null;
  execution_instance_id: string | null;
  repo_root: string;
  base_commit: string;
  branch: string;
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
    repo_root: row.repo_root,
    base_commit: row.base_commit,
    branch: row.branch,
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

function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
}

const EXECUTION_FENCING_TRIGGERS = [
  'trg_tasks_execution_invariant_insert',
  'trg_tasks_execution_invariant_update',
] as const;

function triggerExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function createExecutionFencingTriggers(db: DatabaseSync): void {
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
  `);
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

function validateFencingObjects(db: DatabaseSync): void {
  for (const name of EXECUTION_FENCING_TRIGGERS) {
    if (!triggerExists(db, name)) {
      throw new DomainError(
        'SCHEMA_FENCING_MISSING',
        `Required execution fencing trigger ${name} is missing`,
        { trigger: name },
      );
    }
  }
}

function migrateAndValidate(db: DatabaseSync): void {
  const userVersion = Number(pragmaValue(db, 'user_version'));
  if (userVersion === 0) {
    db.exec(CREATE_SCHEMA_SQL);
    createExecutionFencingTriggers(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (userVersion === 1 || userVersion === 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
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

      validateExecutionInvariantRows(db);
      createExecutionFencingTriggers(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      }
      throw error;
    }
  } else if (userVersion !== SCHEMA_VERSION) {
    throw new DomainError(
      'SCHEMA_MISMATCH',
      `Unsupported schema user_version ${userVersion}; expected ${SCHEMA_VERSION}`,
      { actual: userVersion, expected: SCHEMA_VERSION },
    );
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
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'task_events', 'ledger_metadata')`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (!names.has('tasks') || !names.has('task_events') || !names.has('ledger_metadata')) {
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
      migrateAndValidate(db);
      let boundRepoRoot: string | undefined;
      if (options?.repoRoot !== undefined) {
        db.exec('BEGIN IMMEDIATE');
        try {
          requireRepositoryBinding(db, options.repoRoot);
          db.exec('COMMIT');
        } catch (error) {
          if (db.isTransaction) {
            db.exec('ROLLBACK');
          }
          throw error;
        }
        boundRepoRoot = options.repoRoot;
      }
      return new Store(path, db, boundRepoRoot);
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

  transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
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

  insertTask(task: TaskContract): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, type, status, owner_role, assignee_role, execution_instance_id,
          repo_root, base_commit, branch, payload_json, result_json, blocker_json,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.type,
        task.status,
        task.owner_role,
        task.assignee_role,
        task.execution_instance_id,
        task.repo_root,
        task.base_commit,
        task.branch,
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
          repo_root = ?, base_commit = ?, branch = ?, payload_json = ?, result_json = ?,
          blocker_json = ?, revision = ?, created_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        task.type,
        task.status,
        task.owner_role,
        task.assignee_role,
        task.execution_instance_id,
        task.repo_root,
        task.base_commit,
        task.branch,
        JSON.stringify(task.payload),
        task.result === null ? null : JSON.stringify(task.result),
        task.blocker === null ? null : JSON.stringify(task.blocker),
        task.revision,
        task.created_at,
        task.updated_at,
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
          task_id, at, actor_role, kind, from_status, to_status, revision, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
}
