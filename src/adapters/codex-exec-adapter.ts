import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../orchestration/types.ts';
import { resolveCodexLauncher, type CodexLaunch } from './codex-launcher.ts';

export const LUNA_MODEL = 'gpt-5.6-luna';

function runtimeDir(dispatchRunId: string): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'engineering-mcp', 'runs', dispatchRunId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function taskPrompt(context: AdapterContext): string {
  const task = context.task;
  if (task.type !== 'IMPLEMENTATION') {
    throw new Error('CodexExecAdapter currently supports IMPLEMENTATION tasks only');
  }
  const p = task.payload as {
    goal: string;
    parent_intent: string;
    allowed_scope: string[];
    forbidden_scope: string[];
    acceptance_criteria: string[];
    validation_requirements: string[];
    context_files: string[];
    knowledge_refs: string[];
    parent_risk: string;
  };
  return [
    `You are Luna, a bounded implementation worker in Engineering MCP.`,
    `The trusted Worker Runner has already claimed this task. Do NOT manage Engineering MCP lifecycle.`,
    `Repository: ${context.repositoryRoot}`,
    `Base commit: ${context.baseCommit}`,
    `Task ID: ${context.taskId}`,
    `Dispatch run ID: ${context.dispatchRunId}`,
    ``,
    `Goal: ${p.goal}`,
    `Parent intent: ${p.parent_intent}`,
    `Allowed scope: ${p.allowed_scope.join(', ')}`,
    `Forbidden scope: ${p.forbidden_scope.join(', ')}`,
    `Acceptance criteria: ${p.acceptance_criteria.join(', ')}`,
    `Validation requirements: ${p.validation_requirements.join(', ')}`,
    `Context files: ${p.context_files.join(', ')}`,
    `Knowledge refs: ${p.knowledge_refs.join(', ')}`,
    `Parent risk: ${p.parent_risk}`,
    ``,
    `Rules:`,
    `- Do NOT commit, stash, reset, or otherwise mutate Git history.`,
    `- Stay inside allowed scope and obey forbidden scope.`,
    `- Do not attempt to claim, report, recover, or modify Engineering MCP task state.`,
    `- Execute the required validation.`,
    `- Finish with a machine-parseable JSON object on the last line or in the final message.`,
    `Required final JSON shape:`,
    `{"outcome":"completed|blocked","summary":"...","changed_files":["..."],"validation":[{"check":"...","status":"passed|failed|not_run"}],"known_limitations":["..."],"blocked_reason":"..."}`,
  ].join('\n');
}

function quoteCmdArg(value: string): string {
  if (/[\s""]/.test(value)) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return value;
}

function parseLastMessage(path: string): WorkerResult | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    return JSON.parse(raw.slice(start)) as WorkerResult;
  } catch {
    return undefined;
  }
}

export class CodexExecAdapter implements WorkerAdapter {
  readonly id = 'codex-exec-luna';
  private launch: CodexLaunch | undefined;

  async probe(): Promise<void> {
    this.launch = resolveCodexLauncher();
  }

  describeLauncher(): Record<string, unknown> {
    if (!this.launch) {
      this.launch = resolveCodexLauncher();
    }
    return {
      platform: process.platform,
      launcher_kind: this.launch.kind,
      resolved_executable: this.launch.executable,
      wrapper_path: this.launch.displayPath,
      model: LUNA_MODEL,
    };
  }

  async execute(context: AdapterContext): Promise<WorkerResult> {
    const dir = runtimeDir(context.dispatchRunId);
    const outputPath = join(dir, 'last-message.txt');
    try {
      rmSync(outputPath, { force: true });
    } catch {
      // ignore
    }

    const prompt = taskPrompt(context);
    const launch = resolveCodexLauncher();
    this.launch = launch;
    const codexArgs = [
      'exec',
      '--model',
      LUNA_MODEL,
      '-C',
      context.repositoryRoot,
      '-s',
      'workspace-write',
      '--json',
      '--ephemeral',
      '--output-last-message',
      outputPath,
      '-',
    ];
    const child =
      launch.kind === 'cmd'
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              `call ${quoteCmdArg(launch.executable)} ${codexArgs.map(quoteCmdArg).join(' ')}`,
            ],
            {
              cwd: context.repositoryRoot,
              shell: false,
              windowsHide: true,
            },
          )
        : spawn(launch.executable, codexArgs, {
            cwd: context.repositoryRoot,
            shell: false,
            windowsHide: true,
          });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });

    const result = parseLastMessage(outputPath);
    if (result) {
      return { ...result, exit_code: exitCode ?? 1 };
    }

    return {
      outcome: 'blocked',
      summary: 'Worker did not produce a parseable structured result',
      changed_files: [],
      validation: [{ check: 'worker-protocol', status: 'failed' }],
      known_limitations: [],
      blocked_reason: 'WORKER_PROTOCOL_FAILURE',
      exit_code: exitCode ?? 1,
    };
  }
}
