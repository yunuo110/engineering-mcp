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
    // Readiness means the holder has actually acquired the SQLite write lock.
    process.stdout.write('LOCK_ACQUIRED\n');

    // Keep the transaction open until the parent explicitly sends RELEASE.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk.trim() === 'RELEASE') {
        db.exec('ROLLBACK');
        db.close();
        process.exit(0);
      }
    });
    process.stdin.resume();
    setInterval(() => {}, 1000);
    return;
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  store.close();
  process.exit(0);
}

main();
