import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { DomainError, type DomainErrorCode } from '../src/errors.ts';
import { inspectRepo } from '../src/git.ts';
import { createEngineeringServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import type { GitSnapshot, ImplementationPayload, DiagnosisPayload, ProcessRole } from '../src/types.ts';
import { expect } from 'vitest';

export function expectDomain(fn: () => unknown, code: DomainErrorCode): void {
  try {
    fn();
    throw new Error(`expected DomainError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

export const implPayload: ImplementationPayload = {
  goal: 'Add the ledger store',
  parent_intent: 'Engineering MCP V1',
  allowed_scope: ['src/store.ts'],
  forbidden_scope: ['AGENTS.md'],
  acceptance_criteria: ['store tests pass'],
  validation_requirements: ['npm test'],
  context_files: ['src/store.ts'],
  knowledge_refs: ['AGENTS.md'],
  parent_risk: 'L1',
};

export const diagnosisPayload: DiagnosisPayload = {
  problem: 'Writer slot may be held across BLOCKED',
  desired_outcome: 'Identify the invariant and repair',
  confirmed_facts: ['One RUNNING task per ledger'],
  evidence_refs: ['src/lifecycle.ts'],
  disproved_hypotheses: [],
  open_questions: ['Does cancel release the slot?'],
  constraints: ['No heartbeat'],
  context_files: ['src/lifecycle.ts'],
  knowledge_refs: ['AGENTS.md'],
  risk: 'L2',
};

export const implResult = {
  summary: 'Implemented store and tests',
  changed_files: ['src/store.ts', 'test/store.test.ts'],
  validation: [
    { check: 'npm test', status: 'passed' as const },
    { check: 'browser', status: 'not_run' as const },
  ],
  existing_tests_changed: [],
  scope_changes: [],
  unverified: ['Windows file locking under load'],
  working_tree_status: { clean: true, porcelain: '' },
};

export const diagnosisResult = {
  verdict: 'CONFIRMED' as const,
  root_cause: 'Status RUNNING is the writer slot',
  violated_invariant: 'At most one RUNNING task',
  evidence_refs: ['src/store.ts'],
  alternatives_ruled_out: ['Separate writer table'],
  minimal_repair: 'Keep unique index on RUNNING',
  files_to_change: ['src/lifecycle.ts'],
  files_not_to_change: ['AGENTS.md'],
  required_validation: ['lifecycle tests'],
  implementation_recommendation: 'RETURN_TO_GROK' as const,
  confidence: 'HIGH' as const,
  remaining_unknowns: [],
};

export function cleanGit(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    repoRoot: 'C:\\repo',
    branch: 'master',
    head: 'aaa111',
    clean: true,
    porcelain: '',
    ...overrides,
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export function canonicalRepoRoot(repo: string): string {
  return realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
}

export function initGitRepo(): string {
  const dir = tempDir('eng-mcp-repo-');
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return canonicalRepoRoot(dir);
}

export function openTempStore(repoRoot?: string): { store: Store; dir: string } {
  const dir = tempDir('eng-mcp-db-');
  const store = Store.open(join(dir, 'ledger.sqlite'), repoRoot === undefined ? undefined : { repoRoot });
  return { store, dir };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export type Connected = {
  client: Client;
  server: McpServer;
  store: Store;
  executionInstanceId: string;
  close: () => Promise<void>;
};

export async function connectInProcess(
  processRole: ProcessRole,
  repoPath: string,
  store: Store,
  executionInstanceId: string = randomUUID(),
  workerProfiles = builtinWorkerProfiles(),
): Promise<Connected> {
  const server = createEngineeringServer({
    processRole,
    repoPath,
    store,
    executionInstanceId,
    workerProfiles,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    store,
    executionInstanceId,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const serverEntry = join(projectRoot, 'src', 'index.ts');

export async function connectStdio(
  processRole: ProcessRole,
  repoPath: string,
  dbPath: string,
): Promise<{ client: Client; transport: StdioClientTransport; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--role', processRole, '--repo', repoPath, '--db', dbPath],
    cwd: projectRoot,
    env: spawnEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke-client', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

export function snapshot(repo: string): GitSnapshot {
  return inspectRepo(repo);
}

export function makeDirty(repo: string): void {
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
}

export function extraCommit(repo: string, name = 'next.txt'): void {
  writeFileSync(join(repo, name), `${name}\n`);
  git(repo, ['add', name]);
  git(repo, ['commit', '-m', name]);
}

export function cloneRepo(source: string): string {
  const dir = tempDir('eng-mcp-clone-');
  execFileSync('git', ['clone', source, dir], {
    encoding: 'utf8',
    windowsHide: true,
  });
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return canonicalRepoRoot(dir);
}

