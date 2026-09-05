import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../orchestration/types.ts';
import { buildWorkerRequest, ewpResultSchema, ewpResultToWorkerResult, EWP_PROTOCOL } from './ewp.ts';
import { expandTrustedVariables, type CliAdapterManifest } from './manifest.ts';

function runtimeDir(dispatchRunId: string): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'engineering-mcp', 'runs', dispatchRunId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function findLastJsonObject(stdout: string): unknown | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const start = line.indexOf('{');
    if (start >= 0) {
      try {
        return JSON.parse(line.slice(start));
      } catch {
        // try earlier lines
      }
    }
  }
  return undefined;
}

function findJsonlEvent(stdout: string, field: string, equals: string): unknown | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let result: unknown;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj[field] === equals) result = obj;
    } catch {
      // skip
    }
  }
  return result;
}

function promptWrapper(protocolMode: string, requestJson: string): string {
  if (protocolMode === 'native') return requestJson;
  return [
    'You are an execution worker.',
    '',
    'The trusted Engineering MCP Worker Runner already owns task lifecycle.',
    '',
    'Do not commit.',
    'Do not stash.',
    'Do not reset.',
    'Stay within allowed scope.',
    'Respect forbidden scope.',
    'Run required validation.',
    '',
    'Return ONLY an Engineering Worker Protocol v1 JSON object.',
    '',
    requestJson,
  ].join('\n');
}

export class GenericCliAdapter implements WorkerAdapter {
  readonly id: string;
  private readonly manifest: CliAdapterManifest;
  private readonly model: string | undefined;
  private readonly profile: string | undefined;

  constructor(manifest: CliAdapterManifest, options: { model?: string; profile?: string } = {}) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.model = options.model;
    this.profile = options.profile;
  }

  async probe(): Promise<void> {}

  async execute(context: AdapterContext): Promise<WorkerResult> {
    const runDir = runtimeDir(context.dispatchRunId);
    const request = buildWorkerRequest(
      context.task,
      context.repositoryRoot,
      context.baseCommit,
      context.dispatchRunId,
    );
    const requestJson = JSON.stringify(request);
    const prompt = promptWrapper(this.manifest.protocol_mode, requestJson);

    const vars: Record<string, string> = {
      repo_root: context.repositoryRoot,
      run_dir: runDir,
      task_id: context.taskId,
      dispatch_run_id: context.dispatchRunId,
      model: this.model ?? '',
      profile: this.profile ?? '',
    };

    const args = this.manifest.arguments.map((arg) => expandTrustedVariables(arg, vars));
    if (this.manifest.prompt.transport === 'file') {
      const requestPath = join(runDir, 'request.json');
      writeFileSync(requestPath, requestJson, 'utf8');
      const argument = this.manifest.prompt.argument ?? '--prompt-file';
      args.push(argument, requestPath);
    }

    const cwd = expandTrustedVariables(this.manifest.working_directory, vars);
    const child = spawn(this.manifest.command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    let spawnError: Error | null = null;
    child.on('error', (error) => { spawnError = error; });
    if (this.manifest.prompt.transport === 'stdin') {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });

    if (spawnError) {
      throw spawnError;
    }

    let parsed: unknown;
    if (this.manifest.result.source === 'file') {
      const path = expandTrustedVariables(this.manifest.result.path ?? '', vars);
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        parsed = undefined;
      }
    } else if (this.manifest.result.format === 'json') {
      parsed = findLastJsonObject(stdout);
    } else {
      const event = this.manifest.result.final_event;
      const rawEvent = event ? findJsonlEvent(stdout, event.field, event.equals) : undefined;
      if (rawEvent && typeof rawEvent === 'object' && event) {
        const stripped = { ...rawEvent } as Record<string, unknown>;
        delete stripped[event.field];
        parsed = stripped;
      } else {
        parsed = rawEvent;
      }
    }

    const resultSchema = ewpResultSchema.safeParse(parsed);
    if (resultSchema.success) {
      return ewpResultToWorkerResult(resultSchema.data);
    }

    const success = this.manifest.process.success_exit_codes.includes(exitCode ?? -1);
    if (!success) {
      return {
        outcome: 'blocked',
        summary: `Worker process failed: ${stderr.trim() || 'no stderr'}`,
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'WORKER_PROCESS_FAILED',
        exit_code: exitCode ?? 1,
      };
    }

    return {
      outcome: 'blocked',
      summary: 'Worker result did not match Engineering Worker Protocol v1',
      changed_files: [],
      validation: [],
      known_limitations: [],
      blocked_reason: 'WORKER_PROTOCOL_FAILURE',
      exit_code: exitCode ?? 1,
    };
  }
}
