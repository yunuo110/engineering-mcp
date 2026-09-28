import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { durableEvaluateC2CMessage } from '../../src/receipts/c2c-evaluation.ts';
import { Store } from '../../src/store.ts';

const parsed = parseArgs({
  options: {
    mode: { type: 'string' },
    store: { type: 'string' },
    repo: { type: 'string' },
    message: { type: 'string' },
    context: { type: 'string' },
    stage: { type: 'string' },
  },
  strict: true,
});

const values = parsed.values;
if (!values.mode || !values.store) {
  throw new Error('mode and store are required');
}

if (values.mode === 'cold-v8') {
  const db = new DatabaseSync(values.store);
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
    const version = Number(Object.values(row)[0]);
    if (version !== 8) {
      throw new Error('Unsupported schema user_version ' + version + '; expected 8');
    }
  } finally {
    db.close();
  }
  process.exit(0);
}

if (!values.repo) {
  throw new Error('repo is required');
}

if (values.mode === 'open-current') {
  Store.open(values.store, { repoRoot: values.repo }).close();
  process.exit(0);
}

if (values.mode !== 'evaluate' && values.mode !== 'crash') {
  throw new Error('unsupported mode: ' + values.mode);
}
if (!values.message || !values.context) {
  throw new Error('message and context are required');
}

const store = Store.open(values.store, { repoRoot: values.repo });
try {
  const message = JSON.parse(values.message) as unknown;
  const context = JSON.parse(values.context) as unknown;
  const result = durableEvaluateC2CMessage(
    store,
    message,
    context,
    values.mode === 'crash'
      ? {
          onStage(stage) {
            if (stage === values.stage) {
              process.exit(
                stage === 'after_evaluation'
                  ? 81
                  : stage === 'after_insert'
                    ? 82
                    : 83,
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
