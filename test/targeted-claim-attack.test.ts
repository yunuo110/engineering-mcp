import { afterEach, describe, expect, it } from 'vitest';
import { cancelTask, claimTask, createTask, inspectClaimableTask, reportBlocked, resumeTask } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import { cleanGit, implPayload, openTempStore, removeDir } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('targeted claim attack cases', () => {
  it('rejects tickets inspected from the wrong repo, branch, or HEAD', () => {
    const opened = openTempStore('C:\\repo');
    dirs.push(opened.dir);
    stores.push(opened.store);
    const task = createTask(opened.store, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    for (const git of [
      cleanGit({ repoRoot: 'C:\\other' }),
      cleanGit({ branch: 'other' }),
      cleanGit({ head: 'bbb222' }),
    ]) {
      expect(() => inspectClaimableTask(opened.store, git, 'JUNIOR', task.id)).toThrow();
      expect(() => claimTask(opened.store, git, 'JUNIOR', 'worker', task.id, task.revision)).toThrow();
    }
  });

  it('invalidates an inspected ticket after a concurrent READY transition', () => {
    const opened = openTempStore('C:\\repo');
    dirs.push(opened.dir);
    stores.push(opened.store);
    const task = createTask(opened.store, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const ticket = inspectClaimableTask(opened.store, cleanGit(), 'JUNIOR', task.id);
    const cancelled = cancelTask(opened.store, task.id, task.revision);
    expect(cancelled.revision).toBe(ticket.revision + 1);
    expect(() => claimTask(opened.store, cleanGit(), 'JUNIOR', 'stale-worker', ticket.task_id, ticket.revision)).toThrow(/revision/i);
  });

  it('invalidates an old ticket after a later blocked task is resumed to READY', () => {
    const opened = openTempStore('C:\\repo');
    dirs.push(opened.dir);
    stores.push(opened.store);
    const task = createTask(opened.store, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const oldTicket = inspectClaimableTask(opened.store, cleanGit(), 'JUNIOR', task.id);
    const running = claimTask(opened.store, cleanGit(), 'JUNIOR', 'first-claim', task.id, oldTicket.revision);
    const blocked = reportBlocked(opened.store, 'JUNIOR', 'first-claim', {
      task_id: running.id,
      revision: running.revision,
      blocker: { reason: 'OTHER', summary: 'retry', need_from_owner: 'resume', evidence_refs: [] },
    });
    const resumed = resumeTask(opened.store, cleanGit(), { task_id: blocked.id, revision: blocked.revision });

    expect(resumed.status).toBe('READY');
    expect(() => claimTask(opened.store, cleanGit(), 'JUNIOR', 'stale-claim', task.id, oldTicket.revision)).toThrow(
      /revision/i,
    );
  });
});
