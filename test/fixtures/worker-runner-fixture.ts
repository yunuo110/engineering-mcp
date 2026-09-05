import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectRepo } from '../../src/git.ts';
import { claimTask } from '../../src/lifecycle.ts';
import { runWorkerRunner } from '../../src/orchestration/worker-runner.ts';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../../src/orchestration/types.ts';
import { Store } from '../../src/store.ts';

class FixtureAdapter implements WorkerAdapter {
  readonly id = 'fixture-adapter';
  private readonly mode: string;
  private readonly delayMs: number;

  constructor(mode: string, delayMs: number) {
    this.mode = mode;
    this.delayMs = delayMs;
  }

  async probe(): Promise<void> {}

  async execute(context: AdapterContext): Promise<WorkerResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.mode === 'out-of-scope') {
      writeFileSync(join(context.repositoryRoot, 'README.md'), 'allowed change\n', { flag: 'a' });
      writeFileSync(join(context.repositoryRoot, 'outside.txt'), 'forbidden\n');
      return {
        outcome: 'completed',
        summary: 'out of scope',
        changed_files: ['README.md', 'outside.txt'],
        validation: [],
        known_limitations: [],
        exit_code: 0,
      };
    }
    if (this.mode === 'head-change') {
      writeFileSync(join(context.repositoryRoot, 'outside.txt'), 'committed\n');
      execFileSync('git', ['add', 'outside.txt'], { cwd: context.repositoryRoot });
      execFileSync('git', ['commit', '-m', 'fixture head change'], { cwd: context.repositoryRoot });
      return {
        outcome: 'completed',
        summary: 'head changed',
        changed_files: ['outside.txt'],
        validation: [],
        known_limitations: [],
        exit_code: 0,
      };
    }
    if (this.mode === 'protocol-failure') {
      return { outcome: 'garbage' } as unknown as WorkerResult;
    }
    if (this.mode === 'throw') {
      throw new Error('fixture adapter crashed');
    }
    if (this.mode === 'blocked') {
      return {
        outcome: 'blocked',
        summary: 'fixture blocked',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'FIXTURE_BLOCKED',
        exit_code: 1,
      };
    }
    return {
      outcome: 'completed',
      summary: 'fixture completed',
      changed_files: [],
      validation: [{ check: 'fixture', status: 'passed' }],
      known_limitations: [],
      exit_code: 0,
    };
  }
}

function main(): void {
  const parsed = parseArgs({
    options: {
      store: { type: 'string' },
      repo: { type: 'string' },
      task: { type: 'string' },
      revision: { type: 'string' },
      dispatch: { type: 'string' },
      adapter: { type: 'string' },
      mode: { type: 'string', default: 'completed' },
      delay: { type: 'string', default: '0' },
    },
    strict: true,
  });
  const values = parsed.values;
  if (!values.store || !values.repo || !values.task || !values.revision || !values.dispatch || !values.mode) {
    throw new Error('missing fixture args');
  }

  const store = Store.open(values.store, { repoRoot: values.repo });
  const git = inspectRepo(values.repo);
  const executionInstanceId = randomUUID();
  const delayMs = Number(values.delay ?? 0);

  if (values.mode === 'crash-after-claim') {
    claimTask(store, git, 'JUNIOR', executionInstanceId, values.task, Number(values.revision));
    // Simulate crash after claim, before report.
    process.exit(9);
  }

  runWorkerRunner({
    store,
    git,
    taskId: values.task,
    expectedRevision: Number(values.revision),
    executionInstanceId,
    dispatchRunId: values.dispatch,
    adapter: new FixtureAdapter(values.mode, delayMs),
  })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    })
    .finally(() => {
      store.close();
    });
}

main();
