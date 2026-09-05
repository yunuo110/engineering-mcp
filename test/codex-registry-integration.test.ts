import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/adapters/registry.ts';
import { CodexExecAdapter } from '../src/adapters/codex-exec-adapter.ts';
import { createTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type { Store } from '../src/store.ts';
import { initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const originalLauncher = process.env.ENGINEERING_MCP_CODEX_LAUNCHER;
const originalStub = process.env.ENGINEERING_MCP_CODEX_STUB;

afterEach(() => {
  if (originalLauncher === undefined) delete process.env.ENGINEERING_MCP_CODEX_LAUNCHER;
  else process.env.ENGINEERING_MCP_CODEX_LAUNCHER = originalLauncher;
  if (originalStub === undefined) delete process.env.ENGINEERING_MCP_CODEX_STUB;
  else process.env.ENGINEERING_MCP_CODEX_STUB = originalStub;
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.cmd', import.meta.url));

describe('codex-exec-luna registry compatibility', () => {
  it('createAdapter resolves codex-exec-luna to CodexExecAdapter', () => {
    const adapter = createAdapter('codex-exec-luna', {});
    expect(adapter).toBeInstanceOf(CodexExecAdapter);
    expect(adapter.id).toBe('codex-exec-luna');
  });

  it('createAdapter rejects unknown ids', () => {
    expect(() => createAdapter('definitely-unknown', {})).toThrow('unknown adapter');
  });

  it('delegateTask through real Worker Runner uses codex-exec-luna alias', async () => {
    process.env.ENGINEERING_MCP_CODEX_STUB = '1';
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const db = opened.store;
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'No-op',
        parent_intent: 'registry regression',
        allowed_scope: [],
        forbidden_scope: [],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'codex-exec-luna',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(run.adapter_id).toBe('codex-exec-luna');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });
});
