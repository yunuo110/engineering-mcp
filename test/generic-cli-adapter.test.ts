import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GenericCliAdapter, promptWrapper } from '../src/adapters/generic-cli-adapter.ts';
import { buildWorkerRequest, ewpRequestSchema, ewpResultSchema } from '../src/adapters/ewp.ts';
import { cliAdapterManifestSchema, validateManifest, expandTrustedVariables } from '../src/adapters/manifest.ts';
import type { TaskContract } from '../src/types.ts';

const task: TaskContract = {
  id: 'task-1',
  type: 'IMPLEMENTATION',
  status: 'READY',
  owner_role: 'OWNER',
  assignee_role: null,
  execution_instance_id: null,
  writer_generation: 2,
  repo_root: 'C:\repo',
  base_commit: 'abc123',
  branch: 'main',
  payload: {
    goal: 'Implement example',
    parent_intent: 'test',
    allowed_scope: ['src/example.ts'],
    forbidden_scope: ['src/secret.ts'],
    acceptance_criteria: ['works'],
    validation_requirements: ['npm test'],
    context_files: ['src/example.ts'],
    knowledge_refs: [],
    parent_risk: 'L1',
  },
  result: null,
  blocker: null,
  revision: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function context(dispatchId = 'dispatch-1') {
  return {
    dispatchRunId: dispatchId,
    taskId: task.id,
    repositoryRoot: process.cwd(),
    baseCommit: task.base_commit,
    task,
  };
}

const stdinManifest = {
  schema: 'engineering-cli-adapter/1',
  id: 'fake-stdin',
  name: 'Fake Stdin',
  adapter: 'generic-cli',
  command: process.execPath,
  arguments: [fileURLToPath(new URL('./fixtures/fake-ewp-stdin.cjs', import.meta.url))],
  working_directory: '${repo_root}',
  prompt: { transport: 'stdin', format: 'engineering-worker/1' },
  result: { source: 'stdout', format: 'json', strategy: 'last-json-object' },
  process: { shell: false, success_exit_codes: [0] },
  protocol_mode: 'native',
};

const jsonlManifest = {
  ...stdinManifest,
  id: 'fake-jsonl',
  command: process.execPath,
  arguments: [fileURLToPath(new URL('./fixtures/fake-ewp-jsonl.cjs', import.meta.url))],
  result: { source: 'stdout', format: 'jsonl', final_event: { field: 'type', equals: 'result' } },
};

const fileManifest = {
  ...stdinManifest,
  id: 'fake-file',
  command: process.execPath,
  arguments: [fileURLToPath(new URL('./fixtures/fake-ewp-file.cjs', import.meta.url))],
  prompt: { transport: 'file', format: 'engineering-worker/1', argument: '--prompt-file' },
  result: { source: 'file', path: '${run_dir}/result.json', format: 'json' },
};

describe('Engineering Worker Protocol v1', () => {
  it('builds and validates a request without execution_instance_id', () => {
    const request = buildWorkerRequest(task, 'C:\repo', 'abc123', 'dispatch-1');
    expect(ewpRequestSchema.safeParse(request).success).toBe(true);
    expect(JSON.stringify(request)).not.toContain('execution_instance_id');
  });

  it('validates completed and blocked results', () => {
    const completed = {
      protocol: 'engineering-worker/1',
      outcome: 'completed',
      summary: 'ok',
      changed_files: [],
      validation: [],
      known_limitations: [],
      exit_code: 0,
    };
    const blocked = { ...completed, outcome: 'blocked', blocked_reason: 'x', exit_code: 1 };
    expect(ewpResultSchema.safeParse(completed).success).toBe(true);
    expect(ewpResultSchema.safeParse(blocked).success).toBe(true);
  });

  it('rejects unknown protocol and incomplete results', () => {
    expect(ewpResultSchema.safeParse({ protocol: 'engineering-worker/2', outcome: 'completed' }).success).toBe(false);
    expect(ewpResultSchema.safeParse({ protocol: 'engineering-worker/1', outcome: 'completed' }).success).toBe(false);
  });
});

describe('Generic CLI adapter manifest', () => {
  it('validates manifest schema', () => {
    expect(cliAdapterManifestSchema.safeParse(stdinManifest).success).toBe(true);
    expect(validateManifest(stdinManifest).ok).toBe(true);
  });

  it('rejects unsafe argv interpolation', () => {
    const bad = { ...stdinManifest, arguments: ['${goal}'] };
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join('')).toContain('unsafe variable');
  });

  it('rejects shell-command template keys via strict schema', () => {
    const bad = { ...stdinManifest, shell_command: 'echo x' };
    expect(cliAdapterManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown manifest schema version', () => {
    expect(validateManifest({ ...stdinManifest, schema: 'engineering-cli-adapter/99' }).ok).toBe(false);
  });

  it('expands only allowed trusted variables', () => {
    expect(expandTrustedVariables('${repo_root}/${task_id}', { repo_root: 'r', task_id: 't' })).toBe('r/t');
    expect(() => expandTrustedVariables('${goal}', {})).toThrow();
  });
});

describe('prompt-wrapper contract', () => {
  const request = JSON.stringify({ protocol: 'engineering-worker/1', request_id: 'r', task: { id: 't' }, repository: { root: 'r', base_commit: 'c' }, worker: { role: 'JUNIOR' } });
  const prompt = promptWrapper('prompt-wrapper', request);

  it('distinguishes REQUEST from TERMINAL RESULT', () => {
    expect(prompt).toContain('REQUEST');
    expect(prompt).toContain('TERMINAL RESULT');
    expect(prompt).toContain('Do not echo, mutate, or return it');
  });

  it('documents required result keys and forbids request envelope fields', () => {
    expect(prompt).toContain('protocol');
    expect(prompt).toContain('outcome');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('changed_files');
    expect(prompt).toContain('validation');
    expect(prompt).toContain('known_limitations');
    expect(prompt).toContain('exit_code');
    expect(prompt).toContain('request_id, task, repository, worker');
  });

  it('contains exact completed result example and JSON-only rules', () => {
    expect(prompt).toContain('"outcome":"completed"'.replace(/"/g, '"'));
    expect(prompt).toContain('"changed_files":["relative/path"]'.replace(/"/g, '"'));
    expect(prompt).toContain('No Markdown code fences');
    expect(prompt).toContain('No prose before or after JSON');
    expect(prompt).not.toContain('```');
  });

  it('native mode returns raw request JSON', () => {
    expect(promptWrapper('native', request)).toBe(request);
  });
});

describe('GenericCliAdapter execution', () => {
  it('runs stdin stdout-json fake CLI', async () => {
    const adapter = new GenericCliAdapter(cliAdapterManifestSchema.parse(stdinManifest));
    const result = await adapter.execute(context());
    expect(result.outcome).toBe('completed');
    expect(result.summary).toBe('fake completed');
  });

  it('runs stdin stdout-jsonl fake CLI', async () => {
    const adapter = new GenericCliAdapter(cliAdapterManifestSchema.parse(jsonlManifest));
    const result = await adapter.execute(context());
    expect(result.outcome).toBe('completed');
    expect(result.summary).toBe('jsonl completed');
  });

  it('runs file-prompt file-result fake CLI', async () => {
    const adapter = new GenericCliAdapter(cliAdapterManifestSchema.parse(fileManifest));
    const result = await adapter.execute(context('dispatch-file'));
    expect(result.outcome).toBe('blocked');
    expect(result.blocked_reason).toBe('required dependency unavailable');
  });
});
