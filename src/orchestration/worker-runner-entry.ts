import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createAdapter } from '../adapters/registry.ts';
import { inspectRepo } from '../git.ts';
import { Store } from '../store.ts';
import { runWorkerRunner } from './worker-runner.ts';

function main(): void {
  const parsed = parseArgs({
    options: {
      store: { type: 'string' },
      repo: { type: 'string' },
      task: { type: 'string' },
      revision: { type: 'string' },
      dispatch: { type: 'string' },
      adapter: { type: 'string' },
      manifest: { type: 'string' },
      profile: { type: 'string' },
      model: { type: 'string' },
    },
    strict: true,
  });
  const values = parsed.values;
  if (!values.store || !values.repo || !values.task || !values.revision || !values.dispatch || !values.adapter) {
    throw new Error('missing worker runner arguments');
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  const git = inspectRepo(values.repo);
  const executionInstanceId = randomUUID();
  const adapter = createAdapter(values.adapter, {
    manifestPath: values.manifest,
    profile: values.profile,
    model: values.model,
  });

  try {
    runWorkerRunner({
      store,
      git,
      taskId: values.task,
      expectedRevision: Number(values.revision),
      executionInstanceId,
      dispatchRunId: values.dispatch,
      adapter,
    })
      .catch((error) => {
        const dispatch = store.getDispatchRun(values.dispatch!);
        if (dispatch && (dispatch.status === 'launching' || dispatch.status === 'running')) {
          const message = error instanceof Error ? error.message : String(error);
          store.updateDispatchRun({
            ...dispatch,
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_code: 'CLAIM_FAILED',
            error_detail: message,
            updated_at: new Date().toISOString(),
          });
        }
        process.exitCode = 1;
      })
      .finally(() => {
        store.close();
      });
  } catch (error) {
    const dispatch = store.getDispatchRun(values.dispatch);
    if (dispatch && (dispatch.status === 'launching' || dispatch.status === 'running')) {
      store.updateDispatchRun({
        ...dispatch,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_code: 'WORKER_PROCESS_FAILED',
        error_detail: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      });
    }
    store.close();
    throw error;
  }
}

main();
