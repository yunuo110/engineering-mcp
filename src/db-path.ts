import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultLedgerPath(repoRoot: string): string {
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'engineering-mcp', 'ledgers', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'repo.json'), `${JSON.stringify({ repoRoot }, null, 2)}\n`);
  return join(dir, 'ledger.sqlite');
}
