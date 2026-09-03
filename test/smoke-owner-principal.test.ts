import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectStdio,
  diagnosisPayload,
  diagnosisResult,
  implPayload,
  initGitRepo,
  removeDir,
  tempDir,
} from './helpers.ts';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

describe('stdio OWNER → PRINCIPAL', () => {
  it('creates, claims, reports, and closes a diagnosis task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-smoke-p-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await connectStdio('owner', repo, dbPath);
    closers.push(owner.close);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'DIAGNOSIS', payload: diagnosisPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const principal = await connectStdio('principal', repo, dbPath);
    closers.push(principal.close);
    const claimed = await principal.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    const claimedTask = structured(claimed).task as {
      status: string;
      type: string;
      revision: number;
      id: string;
    };
    expect(claimedTask.status).toBe('RUNNING');
    expect(claimedTask.type).toBe('DIAGNOSIS');

    const completed = await principal.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: claimedTask.id,
        revision: claimedTask.revision,
        outcome: 'completed',
        result: diagnosisResult,
      },
    });
    const done = structured(completed).task as { status: string; revision: number; id: string };
    expect(done.status).toBe('COMPLETED');

    const closed = await owner.client.callTool({
      name: 'close_task',
      arguments: { task_id: done.id, revision: done.revision },
    });
    expect((structured(closed).task as { status: string }).status).toBe('CLOSED');
  });

  it('does not let principal claim an implementation task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-smoke-p2-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const owner = await connectStdio('owner', repo, dbPath);
    closers.push(owner.close);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    const principal = await connectStdio('principal', repo, dbPath);
    closers.push(principal.close);
    const claimed = await principal.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimed.isError).toBe(true);
    expect((structured(claimed).error as { code: string }).code).toBe('WRONG_TASK_TYPE');
  });
});
