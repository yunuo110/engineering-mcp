import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskOnce } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/types.ts';
import { cleanGit, implPayload, openTempStore, removeDir } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function opened() {
  const result = openTempStore('C:\\repo');
  dirs.push(result.dir);
  stores.push(result.store);
  return result.store;
}

const input = { type: 'IMPLEMENTATION' as const, payload: implPayload };

describe('atomic work submission binding', () => {
  it('returns the same task after response loss, server restart, and Git drift', () => {
    let store = opened();
    const first = createTaskOnce(store, cleanGit(), 'submission-1', input, 'codex-luna');
    expect(store.getWorkSubmission('submission-1')?.task_id).toBe(first.id);
    expect(store.getWorkSubmission('submission-1')?.worker_profile_id).toBe('codex-luna');
    store.close();

    store = Store.open(store.path, { repoRoot: 'C:\\repo' });
    stores.push(store);
    const retry = createTaskOnce(
      store,
      cleanGit({ clean: false, porcelain: ' M src/file.ts', head: 'different-head' }),
      'submission-1',
      input,
      'codex-luna',
    );
    expect(retry).toEqual(first);
    expect(store.listActive()).toHaveLength(1);
    expect(store.listEvents(first.id).map((event) => event.kind)).toEqual(['created']);
  });

  it('rejects reuse of a submission identity for different input', () => {
    const store = opened();
    const first = createTaskOnce(store, cleanGit(), 'submission-2', input, 'codex-luna');
    expect(() => createTaskOnce(store, cleanGit(), 'submission-2', {
      ...input,
      payload: { ...implPayload, goal: 'different goal' },
    }, 'codex-luna')).toThrow(/different input/);
    expect(() => createTaskOnce(store, cleanGit(), 'submission-2', input, 'other-profile'))
      .toThrow(/different input/);
    expect(store.listActive().map((task) => task.id)).toEqual([first.id]);
  });

  it('rolls back task and event when the submission binding write fails', () => {
    const store = opened();
    const raw = new DatabaseSync(store.path);
    raw.exec(`CREATE TRIGGER reject_submission BEFORE INSERT ON ledger_metadata
      WHEN NEW.key LIKE 'work_submission:%'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    raw.close();
    expect(() => createTaskOnce(store, cleanGit(), 'submission-3', input, 'codex-luna')).toThrow(/injected failure/);
    expect(store.listActive()).toHaveLength(0);
    expect(store.getWorkSubmission('submission-3')).toBeUndefined();
    const inspect = new DatabaseSync(store.path);
    expect((inspect.prepare('SELECT COUNT(*) AS count FROM task_events').get() as { count: number }).count).toBe(0);
    inspect.close();
  });

  it('uses existing schema-12 metadata without a migration', () => {
    const store = opened();
    const existing = createTaskOnce(store, cleanGit(), 'submission-4', input, 'codex-luna');
    const raw = new DatabaseSync(store.path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM ledger_metadata WHERE key = 'work_submission:submission-4'")
      .get() as { count: number }).count).toBe(1);
    raw.close();
    expect(store.getTask(existing.id)?.id).toBe(existing.id);
  });

  it('binds explicit scope kind to the durable submission digest', () => {
    const store = opened();
    const scopedInput = { type: 'IMPLEMENTATION' as const,
      payload: { ...implPayload, allowed_scope: ['src/file.ts'] } };
    const fileRules = [{ kind: 'FILE' as const, path: 'src/file.ts' }];
    const task = createTaskOnce(store, cleanGit(), 'submission-scope', scopedInput, 'codex-luna', fileRules);
    expect(store.getWorkSubmission('submission-scope')?.scope_rules).toEqual(fileRules);
    expect(createTaskOnce(store, cleanGit(), 'submission-scope', scopedInput, 'codex-luna', fileRules).id).toBe(task.id);
    expect(() => createTaskOnce(store, cleanGit(), 'submission-scope', scopedInput, 'codex-luna',
      [{ kind: 'SUBTREE', path: 'src/file.ts' }])).toThrow(/different input/);
    expect(() => createTaskOnce(store, cleanGit(), 'different-scope', scopedInput, 'codex-luna',
      [{ kind: 'FILE', path: 'src/other.ts' }])).toThrow(/must match Task allowed_scope/);
  });
});
