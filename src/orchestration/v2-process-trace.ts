import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Inert outside the disposable Windows fault-test fixture. This is diagnostic
// evidence only: no Task, dispatch, receipt or execution decision reads it.
export function testProcessTraceEnabled(): boolean {
  const target = process.env.ENGINEERING_V2_TEST_PROCESS_TRACE_PATH;
  if (process.env.ENGINEERING_V2_TEST_PROCESS_TRACE_SCOPE !== 'controlled-harness'
    || !target || !isAbsolute(target) || basename(target) !== 'v2-process-trace.jsonl') return false;
  const inside = relative(resolve(tmpdir()), resolve(target));
  return inside.length > 0 && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

export function traceTestProcess(event: string, details: Record<string, unknown> = {}): void {
  if (!testProcessTraceEnabled()) return;
  try {
    appendFileSync(process.env.ENGINEERING_V2_TEST_PROCESS_TRACE_PATH!, JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, ppid: process.ppid,
      event, ...details,
    }) + '\n', { encoding: 'utf8' });
  } catch {
    // A diagnostic write must never change the execution result.
  }
}

// A bounded, disposable-fixture-only process gate. It changes no ledger or
// production behavior and exists solely to make a hard-kill boundary observable.
export async function waitAtTestProcessGate(stage: 'before_harness' | 'before_report'): Promise<void> {
  if (!testProcessTraceEnabled() || process.env.ENGINEERING_V2_TEST_PROCESS_GATE_STAGE !== stage) return;
  const directory = dirname(process.env.ENGINEERING_V2_TEST_PROCESS_TRACE_PATH!);
  writeFileSync(join(directory, `v2-gate-${stage}.json`), JSON.stringify({
    pid: process.pid, stage, at: new Date().toISOString(),
  }), { flag: 'wx' });
  traceTestProcess('runner_test_gate_entered', { stage });
  const release = join(directory, `v2-gate-${stage}-release`);
  const deadline = Date.now() + 30000;
  while (!existsSync(release) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!existsSync(release)) throw new Error(`V2_TEST_PROCESS_GATE_TIMEOUT:${stage}`);
  traceTestProcess('runner_test_gate_released', { stage });
}
