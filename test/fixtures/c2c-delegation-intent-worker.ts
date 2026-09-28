import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createAcceptedDispatchIntent } from '../../src/commands/delegation-intent.ts';
import { builtinWorkerProfiles } from '../../src/worker-profiles.ts';
import { Store } from '../../src/store.ts';

const parsed = parseArgs({
  options: {
    mode: { type: 'string', default: 'intent' },
    store: { type: 'string' },
    repo: { type: 'string' },
    command: { type: 'string' },
    context: { type: 'string' },
    exe: { type: 'string' },
    stage: { type: 'string' },
    delay: { type: 'string', default: '1500' },

    // Accepted so this fixture can also act as an ordinary delegate runner
    // that deliberately never claims the task.
    task: { type: 'string' },
    revision: { type: 'string' },
    dispatch: { type: 'string' },
    adapter: { type: 'string' },
  },
  strict: true,
});

const values = parsed.values;

if (values.mode === 'delayed-runner') {
  setTimeout(() => process.exit(0), Number(values.delay ?? '1500'));
} else if (values.mode === 'cold-v10') {
  if (!values.store) throw new Error('store is required');
  const db = new DatabaseSync(values.store);
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
    const version = Number(Object.values(row)[0]);
    if (version !== 10) {
      throw new Error(
        'Unsupported schema user_version ' + version + '; expected 10',
      );
    }
  } finally {
    db.close();
  }
} else if (values.mode === 'open-current') {
  if (!values.store || !values.repo) {
    throw new Error('store and repo are required');
  }
  Store.open(values.store, { repoRoot: values.repo }).close();
} else {
  if (
    !values.store ||
    !values.repo ||
    !values.command ||
    !values.context ||
    !values.exe
  ) {
    throw new Error('store, repo, command, context, and exe are required');
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  try {
    const result = createAcceptedDispatchIntent(
      store,
      JSON.parse(values.command) as unknown,
      JSON.parse(values.context) as unknown,
      builtinWorkerProfiles(),
      {
        launchSpecBuildOptions: {
          platform: 'win32',
          env: {},
          resolveLauncher: () => ({
            kind: 'native',
            executable: values.exe!,
            displayPath: values.exe!,
          }),
        },
        onStage(stage) {
          if (stage === values.stage) {
            process.exit(
              stage === 'after_validation'
                ? 101
                : stage === 'after_dispatch_insert'
                  ? 102
                  : stage === 'after_receipt_insert'
                    ? 103
                    : 104,
            );
          }
        },
      },
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    store.close();
  }
}
