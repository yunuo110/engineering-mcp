import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchRunDir } from '../dispatch-run-dir.ts';
import {
  ENGINEERING_CODEX_LUNA_PROMPT_V1,
  renderEngineeringCodexLunaPromptV1,
} from '../commands/codex-luna-prompt-v1.ts';
import {
  CODEX_LUNA_RESULT_CONTRACT_V1,
  secretSafeLaunchSpecV1Schema,
  type SecretSafeLaunchSpecV1,
} from '../commands/launch-spec.ts';
import { workerResultSchema } from '../orchestration/types.ts';
import type {
  AdapterContext,
  WorkerAdapter,
  WorkerResult,
} from '../orchestration/types.ts';

export type ArtifactVerificationResult =
  | { ok: true }
  | { ok: false; message: string };

export type ExactCodexV1AdapterOptions = {
  platform?: NodeJS.Platform;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      shell: false;
      windowsHide: true;
    },
  ) => ChildProcessWithoutNullStreams;
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyEngineeringLaunchV1Artifact(
  rawSpec: unknown,
  options: Pick<ExactCodexV1AdapterOptions, 'platform'> = {},
): ArtifactVerificationResult {
  const parsed = secretSafeLaunchSpecV1Schema.safeParse(rawSpec);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid engineering-launch/1: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    };
  }
  const spec = parsed.data;
  const platform = options.platform ?? process.platform;
  if (platform !== spec.platform || platform !== 'win32') {
    return {
      ok: false,
      message: `Launch platform mismatch: durable=${spec.platform} runtime=${platform}`,
    };
  }

  let canonical: string;
  try {
    canonical = realpathSync(spec.launcher.executable_path);
  } catch (error) {
    return {
      ok: false,
      message: `Codex executable is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (canonical !== spec.launcher.executable_path) {
    return {
      ok: false,
      message: 'Codex executable canonical path no longer matches durable launch spec',
    };
  }

  try {
    if (!statSync(canonical).isFile()) {
      return {
        ok: false,
        message: 'Codex executable is no longer a regular file',
      };
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not stat Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let digest: string;
  try {
    digest = sha256File(canonical);
  } catch (error) {
    return {
      ok: false,
      message: `Could not hash Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (digest !== spec.launcher.executable_sha256) {
    return {
      ok: false,
      message: 'Codex executable SHA-256 no longer matches durable launch spec',
    };
  }

  return { ok: true };
}

function parseLastMessage(path: string): WorkerResult | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    const parsed = JSON.parse(raw.slice(start)) as unknown;
    const validated = workerResultSchema.safeParse(parsed);
    return validated.success ? (validated.data as WorkerResult) : undefined;
  } catch {
    return undefined;
  }
}
function materializeArgs(
  spec: SecretSafeLaunchSpecV1,
  repositoryRoot: string,
  outputPath: string,
): string[] {
  return spec.argv_template.map((arg) => {
    if (arg === '${task_repo_root}') return repositoryRoot;
    if (arg === '${dispatch_run_dir}/last-message.txt') return outputPath;
    return arg;
  });
}

export class EngineeringCodexLunaV1Adapter implements WorkerAdapter {
  readonly id = 'engineering-codex-luna-v1';
  private readonly spec: SecretSafeLaunchSpecV1;
  private readonly options: ExactCodexV1AdapterOptions;

  constructor(
    rawSpec: unknown,
    options: ExactCodexV1AdapterOptions = {},
  ) {
    this.spec = secretSafeLaunchSpecV1Schema.parse(rawSpec);
    this.options = options;
  }

  async probe(): Promise<void> {
    const verified = verifyEngineeringLaunchV1Artifact(
      this.spec,
      this.options,
    );
    if (!verified.ok) {
      throw new Error(verified.message);
    }
  }

  async execute(context: AdapterContext): Promise<WorkerResult> {
    const verified = verifyEngineeringLaunchV1Artifact(
      this.spec,
      this.options,
    );
    if (!verified.ok) {
      return {
        outcome: 'blocked',
        summary: verified.message,
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'CODEX_ARTIFACT_MISMATCH',
        exit_code: 1,
        runner_error_code: 'CODEX_ARTIFACT_MISMATCH',
      };
    }

    if (
      this.spec.prompt_contract !== ENGINEERING_CODEX_LUNA_PROMPT_V1 ||
      this.spec.result_contract !== CODEX_LUNA_RESULT_CONTRACT_V1
    ) {
      return {
        outcome: 'blocked',
        summary: 'Unsupported durable Codex V1 prompt/result contract',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'WORKER_PROTOCOL_FAILURE',
        exit_code: 1,
        runner_error_code: 'WORKER_PROTOCOL_FAILURE',
      };
    }

    const dir = dispatchRunDir(context.dispatchRunId);
    const outputPath = join(dir, 'last-message.txt');
    try {
      rmSync(outputPath, { force: true });
    } catch {
      // Best-effort stale result cleanup before exact execution.
    }

    const prompt = renderEngineeringCodexLunaPromptV1({
      task: context.task,
      taskId: context.taskId,
      dispatchRunId: context.dispatchRunId,
      repositoryRoot: context.repositoryRoot,
      baseCommit: context.baseCommit,
    });
    const args = materializeArgs(this.spec, context.repositoryRoot, outputPath);
    const spawnProcess =
      this.options.spawnProcess ??
      ((executable, argv, options) =>
        spawn(executable, argv, options) as ChildProcessWithoutNullStreams);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(this.spec.launcher.executable_path, args, {
        cwd: context.repositoryRoot,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      return {
        outcome: 'blocked',
        summary: `Codex process spawn failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'CODEX_PROCESS_FAILED',
        exit_code: 1,
        runner_error_code: 'CODEX_PROCESS_FAILED',
      };
    }

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
      let settled = false;
      const settle = (value: number | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on('error', () => settle(null));
      child.on('close', (code) => settle(code));
    });

    const result = parseLastMessage(outputPath);
    if (exitCode !== 0) {
      return {
        outcome: 'blocked',
        summary: stderr.trim() || stdout.trim() || 'Codex process failed',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'CODEX_PROCESS_FAILED',
        exit_code: exitCode ?? 1,
        runner_error_code: 'CODEX_PROCESS_FAILED',
      };
    }
    if (result) {
      return { ...result, exit_code: exitCode ?? 1 };
    }

    return {
      outcome: 'blocked',
      summary: 'Codex did not produce a parseable engineering-codex-luna-last-message/1 result',
      changed_files: [],
      validation: [{ check: 'worker-protocol', status: 'failed' }],
      known_limitations: [],
      blocked_reason: 'WORKER_PROTOCOL_FAILURE',
      exit_code: exitCode ?? 1,
      runner_error_code: 'WORKER_PROTOCOL_FAILURE',
    };
  }
}
