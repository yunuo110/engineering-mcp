import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Store } from '../../src/store.ts';

const parsed = parseArgs({
  options: {
    mode: { type: 'string' },
    store: { type: 'string' },
    repo: { type: 'string' },
  },
  strict: true,
});
const values = parsed.values;
if (!values.mode || !values.store) {
  throw new Error('mode and store are required');
}

if (values.mode === 'cold-v11') {
  const db = new DatabaseSync(values.store);
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
    const version = Number(Object.values(row)[0]);
    if (version !== 11) {
      throw new Error(
        'Unsupported schema user_version ' + version + '; expected 11',
      );
    }
  } finally {
    db.close();
  }
} else if (values.mode === 'open-current') {
  if (!values.repo) throw new Error('repo is required');
  Store.open(values.store, { repoRoot: values.repo }).close();
} else {
  throw new Error('unknown mode');
}
