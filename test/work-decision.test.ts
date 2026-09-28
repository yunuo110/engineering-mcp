import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { claimTask, createTaskOnce, reportBlocked } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import { pendingWorkDecision, resolveWorkDecision } from '../src/work/decision.ts';
import { cleanGit, implPayload, openTempStore, removeDir } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function blockedFixture() {
  const opened = openTempStore('C:\\repo');
  dirs.push(opened.dir);
  stores.push(opened.store);
  const store = opened.store;
  const created = createTaskOnce(store, cleanGit(), 'submission-1',
    { type: 'IMPLEMENTATION', payload: implPayload }, 'codex-luna');
  const running = claimTask(store, cleanGit(), 'JUNIOR', 'test-worker', created.id, created.revision);
  const blocked = reportBlocked(store, 'JUNIOR', 'test-worker', {
    task_id: running.id, revision: running.revision,
    blocker: { reason: 'PERMISSION', summary: 'External permission denied',
      need_from_owner: 'Repair the external permission and authorize an unchanged retry.', evidence_refs: [] },
  });
  return { store, blocked };
}

describe('durable Work pending decision', () => {
  it('derives a stable pending identity and atomically resumes with a replay receipt', () => {
    let { store, blocked } = blockedFixture();
    const pending = pendingWorkDecision('submission-1', blocked);
    expect(pending?.decision_type).toBe('PERMISSION_RETRY');
    expect(pending?.task_revision).toBe(blocked.revision);
    expect(pending?.resolved).toBe(false);
    const input = { submission_id: 'submission-1', decision_id: pending!.decision_id,
      response_id: 'owner-response-1', action: 'RETRY_UNCHANGED' as const };
    const resolution = resolveWorkDecision(store, cleanGit(), input);
    const resumed = resolution.task;
    expect(resolution.response_replayed).toBe(false);
    expect(resumed.status).toBe('READY');
    expect(resumed.revision).toBe(blocked.revision + 1);
    expect(store.listEvents(resumed.id).map((event) => event.kind)).toEqual(['created', 'claimed', 'blocked', 'resumed']);
    expect(store.getWorkDecisionResponse(input.submission_id, input.response_id)?.resolved_revision).toBe(resumed.revision);
    store.close();
    store = Store.open(store.path, { repoRoot: 'C:\\repo' });
    stores.push(store);
    const replayed = resolveWorkDecision(store, cleanGit({ clean: false, porcelain: ' M src/file.ts' }), input);
    expect(replayed.task.revision).toBe(resumed.revision);
    expect(replayed.response_replayed).toBe(true);
    expect(store.listEvents(resumed.id).filter((event) => event.kind === 'resumed')).toHaveLength(1);
    expect(() => resolveWorkDecision(store, cleanGit(), { ...input,
      action: 'RETRY_UNCHANGED', decision_id: 'a'.repeat(64) })).toThrow(/different content/);
    expect(() => resolveWorkDecision(store, cleanGit(), { ...input, response_id: 'new-response' }))
      .toThrow(/not current/);
  });

  it('rolls back the OWNER resume when the response receipt cannot commit', () => {
    const { store, blocked } = blockedFixture();
    const raw = new DatabaseSync(store.path);
    raw.exec(`CREATE TRIGGER reject_work_response BEFORE INSERT ON ledger_metadata
      WHEN NEW.key LIKE 'work_response:%'
      BEGIN SELECT RAISE(ABORT, 'injected response failure'); END`);
    raw.close();
    const decision = pendingWorkDecision('submission-1', blocked)!;
    expect(() => resolveWorkDecision(store, cleanGit(), {
      submission_id: 'submission-1', decision_id: decision.decision_id,
      response_id: 'owner-response-2', action: 'RETRY_UNCHANGED',
    })).toThrow(/injected response failure/);
    expect(store.getTask(blocked.id)?.status).toBe('BLOCKED');
    expect(store.listEvents(blocked.id).filter((event) => event.kind === 'resumed')).toHaveLength(0);
    expect(store.getWorkDecisionResponse('submission-1', 'owner-response-2')).toBeUndefined();
  });
});
