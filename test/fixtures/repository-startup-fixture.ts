import { resolveRepository } from '../../src/repository-resolver.ts';
import { defaultLedgerPath } from '../../src/db-path.ts';

const argIdx = process.argv.indexOf('--repo');
const arg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
const resolution = resolveRepository({
  arg,
  envRepo: process.env.ENGINEERING_MCP_REPO,
  cwd: process.cwd(),
});
console.log(JSON.stringify({
  repoRoot: resolution.repoRoot,
  source: resolution.source,
  ledgerPath: defaultLedgerPath(resolution.repoRoot),
}));
