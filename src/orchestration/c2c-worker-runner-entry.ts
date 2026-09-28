import { parseArgs } from 'node:util';
import { inspectRepo } from '../git.ts';
import { Store } from '../store.ts';
import { runC2CWorkerRunner } from './c2c-worker-runner.ts';
import { traceTestProcess } from './v2-process-trace.ts';
import { waitForExecutionWitness } from './execution-group.ts';
import { initializeRestrictedWorkerIdentityFromStdin, disposeRestrictedWorkerIdentity } from './restricted-worker-launch.ts';

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      store: { type: 'string' },
      repo: { type: 'string' },
      dispatch: { type: 'string' },
      'execution-instance': { type: 'string' },
      'worker-secret-stdin': { type: 'boolean' },
    },
    strict: true,
  });
  const values = parsed.values;
  if (values['worker-secret-stdin'] !== true) throw new Error('WORKER_IDENTITY_REFUSED:Runner channel required');
  initializeRestrictedWorkerIdentityFromStdin();
  process.once('exit', disposeRestrictedWorkerIdentity);
  if (!values.store || !values.repo || !values.dispatch
    || !values['execution-instance'] || !/^[0-9a-f-]{36}$/.test(values['execution-instance'])) {
    throw new Error('missing C2C worker runner arguments');
  }
  traceTestProcess('runner_entry_start', { dispatch_run_id: values.dispatch,
    store_path: values.store, repo_root: values.repo });
  process.on('exit', (code) => traceTestProcess('runner_process_exit', { code }));

  const store = Store.open(values.store, { repoRoot: values.repo });
  try {
    const witness = waitForExecutionWitness(store.path, values.repo, values.dispatch,
      values['execution-instance']);
    if (!witness || witness.runner_pid !== process.pid) {
      throw new Error('C2C Runner has no matching sealed execution Job witness');
    }
    const git = inspectRepo(values.repo);
    const executionInstanceId = values['execution-instance'];
    traceTestProcess('runner_execution_id_created', { dispatch_run_id: values.dispatch,
      execution_instance_id: executionInstanceId });
    await runC2CWorkerRunner({
      store,
      git,
      dispatchRunId: values.dispatch,
      executionInstanceId,
    });
  } finally {
    disposeRestrictedWorkerIdentity();
    traceTestProcess('runner_store_close_begin', { dispatch_run_id: values.dispatch });
    store.close();
    traceTestProcess('runner_store_closed', { dispatch_run_id: values.dispatch });
  }
}

main().then(() => traceTestProcess('runner_entry_completed')).catch((error) => {
  disposeRestrictedWorkerIdentity();
  traceTestProcess('runner_entry_error', { message: error instanceof Error ? error.message : String(error),
    stack_tail: error instanceof Error ? error.stack?.slice(-2048) ?? null : null });
  // A failed physical Worker attempt is non-authoritative. In particular,
  // claim losers must never mark the logical C2C dispatch failed.
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
