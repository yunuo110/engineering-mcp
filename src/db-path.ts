import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function ledgerDirectory(repoRoot: string): string {
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'engineering-mcp', 'ledgers', key);
}

/**
 * Compute the default ledger path without creating directories or writing
 * metadata. Used by doctor and other read-only public commands.
 */
export function ledgerPathFor(repoRoot: string): string {
  return join(ledgerDirectory(repoRoot), 'ledger.sqlite');
}

export function defaultLedgerPath(repoRoot: string): string {
  const dir = ledgerDirectory(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'repo.json'), `${JSON.stringify({ repoRoot }, null, 2)}\n`);
  return ledgerPathFor(repoRoot);
}
