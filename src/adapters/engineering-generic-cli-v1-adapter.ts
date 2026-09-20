import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  genericCliTargetV1Schema, verifyGenericCliTargetV1, type GenericCliTargetV1,
} from '../commands/generic-cli-target-v1.ts';
import {
  parseEngineeringGenericCliResultV1, renderEngineeringGenericCliEwpNativeV1,
} from '../commands/generic-cli-ewp-native-v1.ts';
import { dispatchRunDir } from '../dispatch-run-dir.ts';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../orchestration/types.ts';

export type ExactGenericCliV1Options = {
  platform?: NodeJS.Platform;
  spawnProcess?: (
    executable: string, args: string[],
    options: { cwd: string; shell: false; windowsHide: true },
  ) => ChildProcessWithoutNullStreams;
};

function blocked(
  code: 'WORKER_PROCESS_FAILED' | 'WORKER_PROTOCOL_FAILURE',
  message: string,
  exitCode = 1,
): WorkerResult {
  return {
    outcome: 'blocked', summary: message, changed_files: [], validation: [],
    known_limitations: [], blocked_reason: code, runner_error_code: code,
    exit_code: exitCode,
  };
}

/** C2C-only adapter. No manifest/profile discovery or lifecycle capability. */
export class EngineeringGenericCliV1Adapter implements WorkerAdapter {
  readonly id = 'engineering-generic-cli-v1';
  private readonly spec: GenericCliTargetV1;
  private readonly options: ExactGenericCliV1Options;

  constructor(rawSpec: unknown, options: ExactGenericCliV1Options = {}) {
    this.spec = genericCliTargetV1Schema.parse(rawSpec);
    this.options = options;
  }

  async probe(): Promise<void> {
    const verified = verifyGenericCliTargetV1(this.spec, this.options);
    if (!verified.ok) throw new Error(verified.message);
  }

  async execute(context: AdapterContext): Promise<WorkerResult> {
    const prompt = renderEngineeringGenericCliEwpNativeV1(context);
    const values = {
      '${repo_root}': context.repositoryRoot,
      '${run_dir}': dispatchRunDir(context.dispatchRunId),
      '${task_id}': context.taskId,
      '${dispatch_run_id}': context.dispatchRunId,
    };
    const args = this.spec.argv_template.map((token) => values[token]);
    // Recheck after claim and immediately before spawn. Failure uses the
    // existing process-failure taxonomy: the authorized process cannot start.
    const verified = verifyGenericCliTargetV1(this.spec, this.options);
    if (!verified.ok) return blocked(verified.code, verified.message);
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      // Runtime credentials belong to the trusted harness environment. They
      // are not accepted from the wire and are never stored in the target.
      child = spawnProcess(this.spec.launcher.executable_path, args, {
        cwd: context.repositoryRoot, shell: false, windowsHide: true,
      });
    } catch {
      return blocked('WORKER_PROCESS_FAILED', 'Exact GenericCli process could not be started');
    }

    let stdout = '';
    let stdoutBytes = 0;
    let processError = false;
    let inputError = false;
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (overflow) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > 8 * 1024 * 1024) {
        overflow = true;
        stdout = '';
        child.kill();
      } else stdout += chunk;
    });
    // Drain stderr without copying possibly credential-bearing diagnostic text
    // into a durable task/receipt. The process outcome is observed separately.
    child.stderr.resume();
    child.stdin.on('error', () => { inputError = true; });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => { processError = true; });
      child.on('close', (code) => resolve(code));
      child.stdin.end(prompt);
    });
    const evidenceExit = exitCode !== null && exitCode >= 0 ? exitCode : 1;
    if (processError || inputError || overflow || exitCode === null ||
        !this.spec.success_exit_codes.includes(exitCode)) {
      return blocked('WORKER_PROCESS_FAILED', overflow
        ? 'GenericCli stdout exceeded the V1 8 MiB text limit'
        : 'Exact GenericCli process did not finish with an authorized success exit code', evidenceExit);
    }
    const result = parseEngineeringGenericCliResultV1(stdout);
    if (!result) return blocked('WORKER_PROTOCOL_FAILURE', 'GenericCli stdout did not contain a strict terminal EWP V1 result', evidenceExit);
    // Harness statements remain reported. The existing Runner independently
    // verifies Git/scope and alone performs the terminal lifecycle transition.
    return { ...result, exit_code: evidenceExit };
  }
}
