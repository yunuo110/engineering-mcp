import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineeringCodexLunaV1Adapter,
  verifyEngineeringLaunchV1Artifact,
} from '../src/adapters/engineering-codex-luna-v1-adapter.ts';
import { renderEngineeringCodexLunaPromptV1 } from '../src/commands/codex-luna-prompt-v1.ts';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { createTask } from '../src/lifecycle.ts';
import { runC2CWorkerRunner } from '../src/orchestration/c2c-worker-runner.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import type { Store } from '../src/store.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  tempDir,
} from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function nativeExe(content = 'exact-codex-v1'): string {
  const dir = tempDir('eng-mcp-b2b-exact-exe-');
  dirs.push(dir);
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, content, 'utf8');
  return exe;
}

function setupIntent() {
  const repo = initGitRepo();
  const opened = openTempStore(repo);
  dirs.push(repo, opened.dir);
  stores.push(opened.store);
  const store = opened.store;
  const task = createTask(store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload: implPayload,
  });

  const message = {
    protocol_version: 'engineering-c2c/1' as const,
    message_id: 'exact-plan-' + task.id,
    task_id: task.id,
    sender_role: 'OWNER' as const,
    state: 'PLAN' as const,
    expected_revision: task.revision,
    goal: 'exact codex execution',
  };
  expect(
    durableEvaluateC2CMessage(
      store,
      message,
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('REQUIRES_OWNER_ACTION');

  const acceptance = 'exact-accept-' + task.id;
  expect(
    acceptEvaluatedPlan(
      store,
      { command_id: acceptance, plan_message: message },
      { actor_role: 'OWNER', repo_root: repo },
    ).decision,
  ).toBe('ACCEPTED');

  const exe = nativeExe();
  const delegated = createAcceptedDispatchIntent(
    store,
    {
      command_id: 'exact-delegate-' + task.id,
      acceptance_command_id: acceptance,
      worker_profile_id: 'codex-luna',
    },
    { actor_role: 'OWNER', repo_root: repo },
    builtinWorkerProfiles(),
    {
      launchSpecBuildOptions: {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    },
  );
  expect(delegated.decision).toBe('CREATED');
  if (delegated.decision !== 'CREATED') {
    throw new Error('failed to create exact C2C intent');
  }

  return {
    repo,
    store,
    task,
    exe,
    receipt: delegated.receipt,
  };
}

function fakeSuccessfulCodexSpawn(capture: {
  executable?: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
}) {
  return (
    executable: string,
    args: string[],
    options: { cwd: string; shell: false; windowsHide: true },
  ): ChildProcessWithoutNullStreams => {
    capture.executable = executable;
    capture.args = [...args];
    capture.cwd = options.cwd;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let prompt = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      prompt += chunk;
    });
    stdin.on('end', () => {
      capture.stdin = prompt;
    });

    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: 4242,
    }) as unknown as ChildProcessWithoutNullStreams;

    const outputFlag = args.indexOf('--output-last-message');
    const outputPath = args[outputFlag + 1]!;
    writeFileSync(
      outputPath,
      JSON.stringify({
        outcome: 'completed',
        summary: 'fake codex completed',
        implementation_complete: true,
        changed_files: [],
        validation: [],
        known_limitations: [],
        exit_code: 0,
      }),
      'utf8',
    );

    setTimeout(() => {
      (child as unknown as EventEmitter).emit('close', 0, null);
    }, 10);

    return child;
  };
}

describe('S3B2B exact engineering-launch/1 Codex consumer', () => {
  it('freezes engineering-codex-luna-prompt/1 independently of mutable adapter prompt code', () => {
    const { repo, task } = setupIntent();
    const rendered = renderEngineeringCodexLunaPromptV1({
      task,
      taskId: task.id,
      dispatchRunId: 'dispatch-v1',
      repositoryRoot: repo,
      baseCommit: task.base_commit,
    });

    expect(rendered).toBe(
      [
        'You are Luna, a bounded implementation worker in Engineering MCP.',
        'The trusted Worker Runner has already claimed this task. Do NOT manage Engineering MCP lifecycle.',
        `Repository: ${repo}`,
        `Base commit: ${task.base_commit}`,
        `Task ID: ${task.id}`,
        'Dispatch run ID: dispatch-v1',
        '',
        'Goal: Add the ledger store',
        'Parent intent: Engineering MCP V1',
        'Allowed scope: src/store.ts',
        'Forbidden scope: AGENTS.md',
        'Acceptance criteria: store tests pass',
        'Validation requirements: npm test',
        'Context files: src/store.ts',
        'Knowledge refs: AGENTS.md',
        'Parent risk: L1',
        '',
        'Rules:',
        '- Do NOT commit, stash, reset, or otherwise mutate Git history.',
        '- Stay inside allowed scope and obey forbidden scope.',
        '- Do not attempt to claim, report, recover, or modify Engineering MCP task state.',
        '- Execute the required validation.',
        '- Finish with a machine-parseable JSON object on the last line or in the final message.',
        'Required final JSON shape:',
        '{"outcome":"completed|blocked","summary":"...","implementation_complete":true,"changed_files":["..."],"validation":[{"command":"...","status":"passed|failed|not_run","summary":"...","counts":{"passed":0,"failed":0,"total":0}}],"git":{"diff_check":{"command":"git diff --check","status":"passed|failed|not_run"}},"environment":{"cwd":"...","platform":"...","runtime":"..."},"known_limitations":["..."],"blocker_classification":"CODE|TEST_FAILURE|VALIDATION_ENVIRONMENT|PERMISSION|TOOL_FAILURE|EXTERNAL_DEPENDENCY|OTHER","blocked_reason":"...","exit_code":0}',
      ].join('\n'),
    );
  });

  it('detects stored artifact mutation without any fallback discovery', () => {
    const { receipt, exe } = setupIntent();
    expect(
      verifyEngineeringLaunchV1Artifact(receipt.launch_spec, {
        platform: 'win32',
      }),
    ).toEqual({ ok: true });

    writeFileSync(exe, 'mutated-after-authorization', 'utf8');
    const result = verifyEngineeringLaunchV1Artifact(
      receipt.launch_spec,
      { platform: 'win32' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/SHA-256/i);
    }
  });

  it('consumes the exact stored executable/argv/prompt and reaches normal terminal lifecycle with a fake Codex child', async () => {
    const { repo, store, receipt } = setupIntent();
    const capture: {
      executable?: string;
      args?: string[];
      cwd?: string;
      stdin?: string;
    } = {};

    const terminal = await runC2CWorkerRunner({
      store,
      git: snapshot(repo),
      dispatchRunId: receipt.dispatch_run_id,
      executionInstanceId: 'exact-c2c-runner',
      adapterOptions: {
        platform: 'win32',
        spawnProcess: fakeSuccessfulCodexSpawn(capture),
      },
    });

    expect(terminal.status).toBe('COMPLETED');
    expect(capture.executable).toBe(
      receipt.launch_spec.launcher.executable_path,
    );
    expect(capture.cwd).toBe(repo);
    expect(capture.args).toEqual([
      'exec',
      '--model',
      'gpt-5.6-luna',
      '-C',
      repo,
      '-s',
      'workspace-write',
      '--json',
      '--ephemeral',
      '--output-last-message',
      expect.stringMatching(/last-message\.txt$/),
      '-',
    ]);
    expect(capture.stdin).toContain(
      'You are Luna, a bounded implementation worker in Engineering MCP.',
    );
    expect(capture.stdin).toContain(
      `Dispatch run ID: ${receipt.dispatch_run_id}`,
    );

    expect(store.getDispatchRun(receipt.dispatch_run_id)).toMatchObject({
      status: 'completed',
      runner_instance_id: 'exact-c2c-runner',
    });
    expect(store.getTask(receipt.task_id)).toMatchObject({
      status: 'COMPLETED',
      execution_instance_id: null,
    });
  });

  it('pre-claim artifact failure leaves the task READY and fails only the logical dispatch for target invalidity', async () => {
    const { repo, store, receipt, exe } = setupIntent();
    writeFileSync(exe, 'artifact-replaced', 'utf8');

    await expect(
      runC2CWorkerRunner({
        store,
        git: snapshot(repo),
        dispatchRunId: receipt.dispatch_run_id,
        executionInstanceId: 'must-not-claim',
        adapterOptions: { platform: 'win32' },
      }),
    ).rejects.toThrow(/SHA-256/i);

    expect(store.getTask(receipt.task_id)).toMatchObject({
      status: 'READY',
      execution_instance_id: null,
      revision: receipt.accepted_revision,
    });
    expect(store.getDispatchRun(receipt.dispatch_run_id)).toMatchObject({
      status: 'failed',
      runner_instance_id: null,
      error_code: 'CODEX_ARTIFACT_MISMATCH',
    });
  });

  it('post-claim Codex process failure becomes BLOCKED instead of leaving a false completion', async () => {
    const { repo, store, receipt } = setupIntent();

    const terminal = await runC2CWorkerRunner({
      store,
      git: snapshot(repo),
      dispatchRunId: receipt.dispatch_run_id,
      executionInstanceId: 'codex-fail-runner',
      adapterOptions: {
        platform: 'win32',
        spawnProcess: (() => {
          throw new Error('synthetic exact Codex spawn failure');
        }) as never,
      },
    });

    expect(terminal.status).toBe('BLOCKED');
    expect(terminal.blocker?.summary).toMatch(/spawn failed/i);
    expect(store.getDispatchRun(receipt.dispatch_run_id)).toMatchObject({
      status: 'blocked',
      error_code: 'CODEX_PROCESS_FAILED',
    });
  });

  it('the exact V1 adapter module does not import mutable launcher/profile resolvers', () => {
    const adapter = new EngineeringCodexLunaV1Adapter(
      setupIntent().receipt.launch_spec,
      { platform: 'win32' },
    );
    expect(adapter.id).toBe('engineering-codex-luna-v1');
  });
});
