import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectInProcess,
  diagnosisPayload,
  implPayload,
  implResult,
  initGitRepo,
  openTempStore,
  removeDir,
  type Connected,
} from './helpers.ts';
import type { Store } from '../src/store.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const connections: Connected[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

async function ownerSession(): Promise<{ repo: string; db: Store; owner: Connected }> {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore();
  stores.push(opened.store);
  dirs.push(opened.dir);
  const owner = await connectInProcess('owner', repo, opened.store);
  connections.push(owner);
  return { repo, db: opened.store, owner };
}

describe('role-filtered tools', () => {
  it('registers only owner tools on an owner process', async () => {
    const { owner } = await ownerSession();
    const listed = await owner.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'cancel_task',
      'close_task',
      'create_task',
      'get_task',
      'list_active_tasks',
      'resume_task',
    ]);
  });

  it('registers only worker tools on junior and principal processes', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore();
    stores.push(opened.store);
    dirs.push(opened.dir);
    const junior = await connectInProcess('junior', repo, opened.store);
    const principal = await connectInProcess('principal', repo, opened.store);
    connections.push(junior, principal);
    const juniorTools = (await junior.client.listTools()).tools.map((tool) => tool.name).sort();
    const principalTools = (await principal.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(juniorTools).toEqual(['claim_task', 'get_task', 'report_blocked', 'report_result']);
    expect(principalTools).toEqual(juniorTools);
  });

  it('creates a task with structured output and rejects a supplied branch', async () => {
    const { owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(created.isError).toBeFalsy();
    const body = structured(created);
    expect(body.ok).toBe(true);
    const task = body.task as { status: string; branch: string; id: string; revision: number };
    expect(task.status).toBe('READY');
    expect(task.branch.length).toBeGreaterThan(0);

    const rejected = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload, branch: 'sneaky' },
    });
    expect(rejected.isError).toBe(true);
    const text = rejected.content[0] && 'text' in rejected.content[0] ? rejected.content[0].text : '';
    expect(text).toContain('Unrecognized key: "branch"');
  });

  it('returns structured domain errors for worker visibility and claim rules', async () => {
    const { repo, db, owner } = await ownerSession();
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const junior = await connectInProcess('junior', repo, db);
    connections.push(junior);
    const peek = await junior.client.callTool({
      name: 'get_task',
      arguments: { task_id: createdTask.id },
    });
    expect(peek.isError).toBe(true);
    expect(structured(peek).ok).toBe(false);
    expect((structured(peek).error as { code: string }).code).toBe('NOT_ASSIGNED');

    const claimed = await junior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimed.isError).toBeFalsy();
    const claimedTask = structured(claimed).task as {
      status: string;
      payload: { goal: string };
      revision: number;
      id: string;
    };
    expect(claimedTask.status).toBe('RUNNING');
    expect(claimedTask.payload.goal).toBe(implPayload.goal);

    const reported = await junior.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: claimedTask.id,
        revision: claimedTask.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(structured(reported).ok).toBe(true);
  });
});
