import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { acceptEvaluatedPlan } from '../../src/commands/plan-acceptance.ts';
import { Store } from '../../src/store.ts';

const parsed = parseArgs({
  options: {
    mode: { type: 'string' },
    store: { type: 'string' },
    repo: { type: 'string' },
    command: { type: 'string' },
    context: { type: 'string' },
    stage: { type: 'string' },
  },
  strict: true,
});

const values = parsed.values;
if (!values.store) throw new Error('store is required');

if (values.mode === 'cold-v9') {
  const db = new DatabaseSync(values.store);
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
    const version = Number(Object.values(row)[0]);
    if (version !== 9) {
      throw new Error(
        'Unsupported schema user_version ' + version + '; expected 9',
      );
    }
  } finally {
    db.close();
  }
  process.exit(0);
}

if (!values.repo) throw new Error('repo is required');

if (values.mode === 'open-current') {
  Store.open(values.store, { repoRoot: values.repo }).close();
  process.exit(0);
}

if (!values.command || !values.context) {
  throw new Error('command and context are required');
}

const store = Store.open(values.store, { repoRoot: values.repo });
try {
  const result = acceptEvaluatedPlan(
    store,
    JSON.parse(values.command) as unknown,
    JSON.parse(values.context) as unknown,
    values.stage
      ? {
          onStage(stage) {
            if (stage === values.stage) {
              process.exit(
                stage === 'after_validation'
                  ? 91
                  : stage === 'after_insert'
                    ? 92
                    : 93,
              );
            }
          },
        }
      : undefined,
  );
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  store.close();
}
