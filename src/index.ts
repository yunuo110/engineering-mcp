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
import { assertWorkPrivateMode } from './work/schema.ts';
import { traceTestProcess } from './orchestration/v2-process-trace.ts';
import { configureProtectedExecutionMode, assertProtectedRepositoryBinding, verifyTrustedRuntime } from './orchestration/trusted-runtime.ts';
import { consumeDevelopmentIdentityChannel, oneTimeIdentityFrame } from './orchestration/development-identity-channel.ts';

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
    'work-private-client'?: boolean;
    'work-contract-version'?: string;
    'development-identity-fd'?: string;
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
        'work-private-client': { type: 'boolean' },
        'work-contract-version': { type: 'string' },
        'development-identity-fd': { type: 'string' },
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
  const workPrivateClient = values['work-private-client'];
  const workContractVersion = values['work-contract-version'];
  assertC2CControllerMode(processRole, enableC2CController);
  configureProtectedExecutionMode(enableC2CController === true);
  let developmentIdentity: ReturnType<typeof oneTimeIdentityFrame> | undefined;
  if (values['development-identity-fd'] !== undefined) {
    if (enableC2CController !== true || values['development-identity-fd'] !== '3') {
      throw new DomainError('USAGE', 'Dedicated development identity pipe requires protected OWNER C2C mode');
    }
    developmentIdentity = oneTimeIdentityFrame(consumeDevelopmentIdentityChannel(3));
    process.once('exit', () => developmentIdentity?.dispose());
  }
  if (enableC2CController === true) verifyTrustedRuntime();
  assertC2CPrivateClientMode(
    processRole,
    enableC2CController,
    c2cPrivateClient,
    c2cContractVersion,
  );
  assertWorkPrivateMode(processRole, workPrivateClient, workContractVersion, enableC2CController, c2cPrivateClient);
  if (enableC2CController === true) {
    // The accepted C2C entry uses the operator-protected builtin profile
    // binding; an argv/environment profile path is not a trusted override.
    if (values['worker-profiles'] || process.env.ENGINEERING_MCP_WORKER_PROFILES) {
      throw new DomainError('USAGE', 'C2C controller rejects external worker profile paths');
    }
  }
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
  assertProtectedRepositoryBinding(dbPath, repoPath);
  const executionInstanceId = randomUUID();
  const store = Store.open(dbPath, { repoRoot: repoPath });
  try { assertProtectedRepositoryBinding(dbPath, repoPath); }
  catch (error) { store.close(); throw error; }

  const workerProfilesPath = values['worker-profiles'] ?? process.env.ENGINEERING_MCP_WORKER_PROFILES;
  const workerProfiles = workerProfilesPath ? loadWorkerProfiles(workerProfilesPath) : builtinWorkerProfiles();

  const closeStore = (): void => {
    traceTestProcess('core_server_store_close_begin');
    store.close();
    traceTestProcess('core_server_store_closed');
  };
  process.on('exit', (code) => { traceTestProcess('core_server_exit', { code }); closeStore(); });
  process.stdin.on('end', () => { traceTestProcess('core_server_stdin_end'); closeStore(); });

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
        workPrivateClient,
        workContractVersion,
        developmentIdentityFrame: developmentIdentity?.take,
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
