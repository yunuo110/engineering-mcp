#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultLedgerPath } from './db-path.ts';
import { DomainError } from './errors.ts';
import { inspectRepo } from './git.ts';
import { createEngineeringServer } from './server.ts';
import { Store } from './store.ts';
import { PROCESS_ROLES, type ProcessRole } from './types.ts';

function parseProcessRole(value: string | undefined): ProcessRole {
  if (value === undefined || !(PROCESS_ROLES as readonly string[]).includes(value)) {
    throw new DomainError(
      'USAGE',
      'Launch with --role owner|junior|principal. Role is process identity, not a tool argument.',
    );
  }
  return value as ProcessRole;
}

function main(): void {
  let values: { role?: string; repo?: string; db?: string };
  try {
    const parsed = parseArgs({
      options: {
        role: { type: 'string' },
        repo: { type: 'string' },
        db: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError('USAGE', message);
  }

  const processRole = parseProcessRole(values.role);
  if (!values.repo) {
    throw new DomainError('USAGE', 'Launch with --repo <target-repository-path>.');
  }

  const git = inspectRepo(values.repo);
  const repoPath = git.repoRoot;
  const dbPath = values.db ? realpathOrCreate(values.db) : defaultLedgerPath(repoPath);
  const store = Store.open(dbPath);

  const closeStore = (): void => {
    store.close();
  };
  process.on('exit', closeStore);
  process.stdin.on('end', closeStore);

  serveStdio(
    () =>
      createEngineeringServer({
        processRole,
        repoPath,
        store,
      }),
    {
      onerror: (error) => {
        console.error(error);
      },
    },
  );
}

function realpathOrCreate(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
