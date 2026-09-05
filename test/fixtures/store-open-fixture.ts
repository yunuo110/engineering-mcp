import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store.ts';

function main(): void {
  const parsed = parseArgs({
    options: {
      store: { type: 'string' },
      repo: { type: 'string' },
      mode: { type: 'string', default: 'open' },
      holdMs: { type: 'string', default: '8000' },
    },
    strict: true,
  });
  const values = parsed.values;
  if (!values.store || !values.repo) throw new Error('missing store/repo args');

  if (values.mode === 'hold-lock') {
    const db = new DatabaseSync(values.store, { timeout: 100 });
    db.exec('BEGIN IMMEDIATE');
    const waitMs = Number(values.holdMs ?? 8000);
    setTimeout(() => {
      db.exec('ROLLBACK');
      db.close();
      process.exit(0);
    }, waitMs);
    setInterval(() => {}, 1000);
    return;
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  store.close();
  process.exit(0);
}

main();
