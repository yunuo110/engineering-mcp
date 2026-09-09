import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.ts';
import { inspectRepo } from '../../src/git.ts';
import { createTask } from '../../src/lifecycle.ts';
import { runWorkerRunner } from '../../src/orchestration/worker-runner.ts';

const [dbPath, repo, mode, taskId, dispatchId] = process.argv.slice(2) as [string, string, string, string, string];
const store = Store.open(dbPath, { repoRoot: repo });
const git = inspectRepo(repo);
if (mode === 'before-commit') {
  store.insertEvent = () => { process.exit(91); };
  createTask(store, git, { type: 'IMPLEMENTATION', payload: {
    goal: 'crash', parent_intent: 'release test', allowed_scope: [], forbidden_scope: [],
    acceptance_criteria: [], validation_requirements: [], context_files: [], knowledge_refs: [], parent_risk: 'L1',
  } });
} else {
  const update = store.updateDispatchRun.bind(store);
  store.updateDispatchRun = (run) => {
    if ((mode === 'claim-dispatch-gap' && run.status === 'running') ||
        (mode === 'terminal-dispatch-gap' && run.status === 'completed')) process.exit(92);
    update(run);
  };
  await runWorkerRunner({
    store, git, taskId, dispatchRunId: dispatchId, expectedRevision: 1, executionInstanceId: 'crash-runner',
    adapter: { id: 'crash-fixture', async probe() {}, async execute() {
      if (mode === 'after-worker-write') {
        writeFileSync(join(repo, 'worker-output.txt'), 'durable worker output\n');
        process.exit(93);
      }
      return { outcome: 'completed', summary: 'finished', changed_files: [], validation: [], known_limitations: [], exit_code: 0 };
    } },
  });
  process.exit(94); // Durable completion, no acknowledgment to caller.
}
