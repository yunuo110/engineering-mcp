#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { userInfo } from 'node:os';
import { assertC2CControllerMode, assertC2CPrivateClientMode } from './c2c/controller.ts';
import {
  C2C_PRIVATE_OPERATION,
  C2C_PRIVATE_TRANSPORT,
} from './c2c/schema.ts';
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
  let values: {
    role?: string;
    repo?: string;
    db?: string;
    'worker-profiles'?: string;
    'enable-c2c-controller'?: boolean;
    'c2c-private-client'?: boolean;
    'c2c-contract-version'?: string;
  };
  try {
    const parsed = parseArgs({
      options: {
        role: { type: 'string' },
        repo: { type: 'string' },
        db: { type: 'string' },
        'worker-profiles': { type: 'string' },
        'enable-c2c-controller': { type: 'boolean' },
        'c2c-private-client': { type: 'boolean' },
        'c2c-contract-version': { type: 'string' },
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
  const enableC2CController = values['enable-c2c-controller'];
  const c2cPrivateClient = values['c2c-private-client'];
  const c2cContractVersion = values['c2c-contract-version'];
  assertC2CControllerMode(processRole, enableC2CController);
  assertC2CPrivateClientMode(
    processRole,
    enableC2CController,
    c2cPrivateClient,
    c2cContractVersion,
  );
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
    () => {
      const server = createEngineeringServer({
        processRole,
        repoPath,
        store,
        executionInstanceId,
        workerProfiles,
        enableC2CController,
        c2cPrivateClient,
        c2cContractVersion,
      });
      if (enableC2CController === true) {
        let username: string | null = null;
        try { username = userInfo().username; } catch { /* identity unavailable, no environment fallback */ }
        console.error(JSON.stringify(c2cPrivateClient === true ? {
          event: 'c2c_private_client_enabled',
          pid: process.pid,
          username,
          role: 'OWNER',
          repo_root: repoPath,
          contract_version: c2cContractVersion,
          transport: C2C_PRIVATE_TRANSPORT,
          tool: C2C_PRIVATE_OPERATION,
          tool_count: 1,
        } : {
          event: 'c2c_controller_enabled', pid: process.pid, username,
          role: 'OWNER', repo_root: repoPath, tool: C2C_PRIVATE_OPERATION,
        }));
      }
      return server;
    },
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
    return resolve(path);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
