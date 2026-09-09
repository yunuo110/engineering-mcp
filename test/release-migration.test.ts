import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { cancelTask, createTask } from '../src/lifecycle.ts';
import { implPayload, initGitRepo, projectRoot, removeDir, snapshot, tempDir } from './helpers.ts';

it('recompiles pre-migration prepared statements under V7 triggers and rejects legacy mutations atomically', () => {
  const repo = initGitRepo();
  mkdirSync(join(projectRoot, '.tmp'), { recursive: true });
  const legacyDir = mkdtempSync(join(projectRoot, '.tmp', 'release-v6-'));
  const dbDir = tempDir('eng-mcp-prepared-');
  const dbPath = join(dbDir, 'ledger.sqlite');
  let old: DatabaseSync | undefined;
  let current: Store | undefined;
  try {
    for (const file of ['store.ts', 'types.ts', 'errors.ts']) {
      writeFileSync(join(legacyDir, file), execFileSync('git', ['show', `c41934e17f76e73b38b3817337119178de3154bc:src/${file}`], { cwd: projectRoot, encoding: 'utf8' }));
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { Store } from ${JSON.stringify(pathToFileURL(join(legacyDir, 'store.ts')).href)}; Store.open(process.argv[1], { repoRoot: process.argv[2] }).close();`, dbPath, repo]);
    old = new DatabaseSync(dbPath);
    const prepared = [
      old.prepare("UPDATE tasks SET status = 'CANCELLED', revision = revision + 1 WHERE id = ?"),
      old.prepare("UPDATE tasks SET status = 'CANCELLED', revision = revision + 1, writer_generation = writer_generation + 1 WHERE id = ?"),
      old.prepare("UPDATE dispatch_runs SET status = 'failed' WHERE task_id = ?"),
      old.prepare("INSERT INTO task_events (task_id, at, actor_role, kind, from_status, to_status, revision, detail_json) VALUES (?, 'now', 'OWNER', 'cancelled', 'READY', 'CANCELLED', 2, NULL)"),
    ];
    current = Store.open(dbPath, { repoRoot: repo });
    const task = createTask(current, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const now = new Date().toISOString();
    current.insertDispatchRun({ id: 'prepared-dispatch', task_id: task.id, worker_role: 'JUNIOR', adapter_id: 'test', worker_profile_id: null,
      runner_instance_id: null, pid: null, status: 'launching', started_at: null, finished_at: null, exit_code: null,
      error_code: null, error_detail: null, created_at: now, updated_at: now });
    const before = JSON.stringify([current.getTask(task.id), current.listEvents(task.id), current.listDispatchRunsForTask(task.id)]);
    for (const statement of prepared) {
      expect(() => statement.run(task.id)).toThrow('CURRENT_PROTOCOL_WRITER_REQUIRED');
      expect(JSON.stringify([current.getTask(task.id), current.listEvents(task.id), current.listDispatchRunsForTask(task.id)])).toBe(before);
    }
    expect(cancelTask(current, task.id, task.revision).status).toBe('CANCELLED');
    expect(current.getDispatchRun('prepared-dispatch')?.status).toBe('failed');
  } finally {
    current?.close(); old?.close();
    for (const dir of [legacyDir, dbDir, repo]) removeDir(dir);
  }
});
