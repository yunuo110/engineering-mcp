import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { inspectRepo } from '../git.ts';
import { Store } from '../store.ts';
import { runC2CWorkerRunner } from './c2c-worker-runner.ts';

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      store: { type: 'string' },
      repo: { type: 'string' },
      dispatch: { type: 'string' },
    },
    strict: true,
  });
  const values = parsed.values;
  if (!values.store || !values.repo || !values.dispatch) {
    throw new Error('missing C2C worker runner arguments');
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  try {
    const git = inspectRepo(values.repo);
    const executionInstanceId = randomUUID();
    await runC2CWorkerRunner({
      store,
      git,
      dispatchRunId: values.dispatch,
      executionInstanceId,
    });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  // A failed physical Worker attempt is non-authoritative. In particular,
  // claim losers must never mark the logical C2C dispatch failed.
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
