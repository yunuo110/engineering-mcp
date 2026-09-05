#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultLedgerPath } from './db-path.ts';
import { DomainError } from './errors.ts';
import { inspectRepo } from './git.ts';
import { resolveRepository, type RepositoryResolution } from './repository-resolver.ts';
import { createEngineeringServer } from './server.ts';
import { Store } from './store.ts';
import { builtinWorkerProfiles, loadWorkerProfiles } from './worker-profiles.ts';
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
  let values: { role?: string; repo?: string; db?: string; 'worker-profiles'?: string };
  try {
    const parsed = parseArgs({
      options: {
        role: { type: 'string' },
        repo: { type: 'string' },
        db: { type: 'string' },
        'worker-profiles': { type: 'string' },
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
  if (!values.role) {
    throw new DomainError('USAGE', 'Launch with --role owner|junior|principal. Role is process identity.');
  }

  const resolution: RepositoryResolution = resolveRepository({
    arg: values.repo,
    envRepo: process.env.ENGINEERING_MCP_REPO,
    cwd: process.cwd(),
  });
  const repoPath = resolution.repoRoot;
  const git = inspectRepo(repoPath);
  const dbPath = values.db ? realpathOrCreate(values.db) : defaultLedgerPath(repoPath);
  const executionInstanceId = randomUUID();
  const store = Store.open(dbPath, { repoRoot: repoPath });

  const workerProfilesPath = values['worker-profiles'] ?? process.env.ENGINEERING_MCP_WORKER_PROFILES;
  const workerProfiles = workerProfilesPath ? loadWorkerProfiles(workerProfilesPath) : builtinWorkerProfiles();

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
        executionInstanceId,
        workerProfiles,
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
