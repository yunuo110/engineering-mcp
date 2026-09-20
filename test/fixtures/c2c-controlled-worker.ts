import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { inspectRepo } from '../../src/git.ts';
import { claimC2CDispatchTask } from '../../src/lifecycle.ts';
import { Store } from '../../src/store.ts';

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
    throw new Error('missing controlled worker args');
  }

  const delayMs = Number(process.env.ENGINEERING_MCP_TEST_C2C_DELAY_MS ?? '0');
  const sentinel = process.env.ENGINEERING_MCP_TEST_C2C_SENTINEL;
  const store = Store.open(values.store, { repoRoot: values.repo });
  try {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const git = inspectRepo(values.repo);
    const executionInstanceId = randomUUID();
    try {
      claimC2CDispatchTask(
        store,
        git,
        executionInstanceId,
        values.dispatch,
      );
    } catch {
      // Expected duplicate-worker loser path: no logical dispatch mutation.
      return;
    }

    if (sentinel) {
      appendFileSync(
        sentinel,
        `fake-codex execution ${executionInstanceId}\n`,
        'utf8',
      );
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
