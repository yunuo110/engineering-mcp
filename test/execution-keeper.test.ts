import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_KEEPER_EXE, executionEvidencePath, executionValidationPath, executionWitnessPath,
  observeExecutionGroup, assertExecutionWritersDrained, readExecutionWitness, recordExecutionValidation,
  releaseUnlaunchedExecutionWitness, reserveExecutionWitness, waitForExecutionWitness } from '../src/orchestration/execution-group.ts';
import { removeDir, tempDir } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/execution-keeper-fixture.mjs', import.meta.url));
const breakawaySource = fileURLToPath(new URL('./fixtures/execution-keeper-breakaway.cs', import.meta.url));
const keeperSource = fileURLToPath(new URL('../src/native/execution-keeper.cs', import.meta.url));
type Group = { root: string; storePath: string; dispatchId: string; instanceId: string;
  keeper: ChildProcess; witnessPath: string };
const groups: Group[] = [];
const evidence = (group: Group, name: 'runtime.sealed.json' | 'runtime.resumed.json' | 'drain-receipt.json') =>
  executionEvidencePath(group.storePath, group.dispatchId, name);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T, okay: (value: T) => boolean, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = read();
  while (!okay(value)) {
    if (Date.now() > deadline) throw new Error('Keeper fixture timed out');
    await delay(50); value = read();
  }
  return value;
}
function marker(group: Group, role: string): { pid: number; ppid: number } | undefined {
  try { return JSON.parse(readFileSync(join(group.root, `${role}.json`), 'utf8')); }
  catch { return undefined; }
}
function release(group: Group, role: string): void {
  const path = join(group.root, `release-${role}`);
  if (!existsSync(path)) writeFileSync(path, 'release\n', { flag: 'wx' });
}
async function start(withBreakaway = false, fault?: 'before_resume' | 'before_receipt'): Promise<Group> {
  const root = tempDir('eng-mcp-keeper-');
  const storePath = join(root, 'ledger.sqlite');
  const dispatchId = randomUUID();
  const instanceId = randomUUID();
  const witnessPath = executionWitnessPath(storePath, dispatchId);
  expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
  expect(reserveExecutionWitness(storePath, dispatchId, randomUUID())).toBe(false);
  const breakawayExe = join(root, 'breakaway.exe');
  const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET',
    'Framework64', 'v4.0.30319', 'csc.exe');
  if (withBreakaway) {
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${breakawayExe}`, breakawaySource],
      { windowsHide: true });
  }
  const keeperExe = fault ? join(root, 'fault-keeper.exe') : EXECUTION_KEEPER_EXE;
  if (fault) execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/define:TEST_FAULT',
    '/r:System.Web.Extensions.dll', `/out:${keeperExe}`, keeperSource], { windowsHide: true });
  const pausePath = join(root, 'before-resume');
  const keeper = spawn(keeperExe,
    ['launch', witnessPath, process.execPath, fixture, storePath, root, dispatchId, instanceId],
    { detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ...(withBreakaway ? { ENGINEERING_V2_TEST_BREAKAWAY_EXE: breakawayExe } : {}),
        ...(fault === 'before_receipt' ? { ENGINEERING_V2_TEST_EXIT_BEFORE_RECEIPT: '1' } : {}),
        ...(fault === 'before_resume' ? { ENGINEERING_V2_TEST_PAUSE_BEFORE_RESUME_FILE: pausePath } : {}) } });
  keeper.on('error', () => {});
  const group = { root, storePath, dispatchId, instanceId, keeper, witnessPath };
  groups.push(group);
  if (fault !== 'before_resume') {
    const witness = waitForExecutionWitness(storePath, root, dispatchId, instanceId);
    expect(witness?.runner_pid).toBeGreaterThan(0);
    await until(() => ['root', 'harness', 'child', 'grandchild'].map((role) => marker(group, role)),
      (rows) => rows.every(Boolean));
  }
  return group;
}

afterEach(async () => {
  for (const group of groups.splice(0)) {
    for (const role of ['root', 'harness', 'child', 'grandchild']) release(group, role);
    await until(() => group.keeper.exitCode !== null || group.keeper.signalCode !== null, Boolean, 8000)
      .catch(() => {});
    removeDir(group.root);
  }
});

describe('split witness reservation', () => {
  it('keeps a bootstrap-only dispatch reserved and fails closed before Keeper starts', () => {
    const root = tempDir('eng-mcp-bootstrap-');
    try {
      const storePath = join(root, 'ledger.sqlite');
      const dispatchId = randomUUID();
      const instanceId = randomUUID();
      expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
      expect(JSON.parse(readFileSync(executionWitnessPath(storePath, dispatchId), 'utf8')))
        .toMatchObject({ state: 'BOOTSTRAPPING', dispatch_run_id: dispatchId, runner_instance_id: instanceId });
      expect(reserveExecutionWitness(storePath, dispatchId, randomUUID())).toBe(false);
      expect(readExecutionWitness(storePath, root, dispatchId, instanceId)).toBeUndefined();
      expect(() => recordExecutionValidation(storePath, root, dispatchId, instanceId))
        .toThrow(/recovery denied/);
      expect(existsSync(executionValidationPath(storePath, dispatchId))).toBe(false);
    } finally { removeDir(root); }
  });

  it('releases only a proven unlaunched reservation and rejects stale legacy reservations', () => {
    const root = tempDir('eng-mcp-release-');
    try {
      const storePath = join(root, 'ledger.sqlite');
      const dispatchId = randomUUID();
      const instanceId = randomUUID();
      expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
      expect(() => releaseUnlaunchedExecutionWitness(storePath, dispatchId, randomUUID()))
        .toThrow(/bootstrap changed/);
      expect(reserveExecutionWitness(storePath, dispatchId, randomUUID())).toBe(false);
      releaseUnlaunchedExecutionWitness(storePath, dispatchId, instanceId);
      expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
      const legacyId = randomUUID();
      writeFileSync(join(root, 'execution-witnesses', `${legacyId}.json`), '{}');
      expect(reserveExecutionWitness(storePath, legacyId, randomUUID())).toBe(false);
    } finally { removeDir(root); }
  });

  it('rejects malformed bootstrap and never converts it into a second reservation', () => {
    const root = tempDir('eng-mcp-malformed-');
    try {
      const storePath = join(root, 'ledger.sqlite');
      const dispatchId = randomUUID();
      const instanceId = randomUUID();
      expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
      writeFileSync(executionWitnessPath(storePath, dispatchId), '{');
      expect(readExecutionWitness(storePath, root, dispatchId, instanceId)).toBeUndefined();
      expect(reserveExecutionWitness(storePath, dispatchId, randomUUID())).toBe(false);
      expect(() => releaseUnlaunchedExecutionWitness(storePath, dispatchId, instanceId))
        .toThrow(/bootstrap changed/);
    } finally { removeDir(root); }
  });
});

describe.skipIf(process.platform !== 'win32')('unnamed per-execution Keeper', () => {
  it('seals before Runner executes, owns no Job membership, observes descendants, then writes one drain receipt', async () => {
    const group = await start();
    const roles = ['root', 'harness', 'child', 'grandchild'];
    const pids = roles.map((role) => marker(group, role)!.pid);
    const alive = await until(() => observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId),
      (value) => value.state === 'ALIVE' && pids.every((pid) => value.process_ids.includes(pid)));
    expect(alive.state).toBe('ALIVE');
    expect(() => assertExecutionWritersDrained(group.storePath, group.root, group.dispatchId, group.instanceId))
      .toThrow(/recovery denied/);
    if (alive.state === 'ALIVE') expect(alive.process_ids).not.toContain(group.keeper.pid);
    for (const role of ['root', 'harness', 'child']) release(group, role);
    const orphan = await until(() => observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId),
      (value) => value.state === 'ALIVE' && value.process_ids.includes(marker(group, 'grandchild')!.pid)
        && !pids.slice(0, 3).some((pid) => value.process_ids.includes(pid)));
    expect(orphan.state).toBe('ALIVE');
    release(group, 'grandchild');
    await until(() => existsSync(evidence(group, 'drain-receipt.json')), Boolean);
    await until(() => group.keeper.exitCode !== null, Boolean);
    expect(existsSync(executionValidationPath(group.storePath, group.dispatchId))).toBe(false);
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('DRAINED');
    expect(() => assertExecutionWritersDrained(group.storePath, group.root, group.dispatchId, group.instanceId))
      .not.toThrow();
    recordExecutionValidation(group.storePath, group.root, group.dispatchId, group.instanceId);
    recordExecutionValidation(group.storePath, group.root, group.dispatchId, group.instanceId);
    expect(existsSync(executionValidationPath(group.storePath, group.dispatchId))).toBe(true);
    const receipt = JSON.parse(readFileSync(evidence(group, 'drain-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ dispatch_run_id: group.dispatchId,
      runner_instance_id: group.instanceId, observed_active_processes: 0 });
    receipt.execution_witness_id = randomUUID().replaceAll('-', '');
    writeFileSync(evidence(group, 'drain-receipt.json'), JSON.stringify(receipt));
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
    expect(() => recordExecutionValidation(group.storePath, group.root, group.dispatchId, group.instanceId))
      .toThrow(/recovery denied/);
  });

  it('Keeper hard loss leaves live members running and never reports DRAINED without receipt', async () => {
    const group = await start();
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('ALIVE');
    expect(group.keeper.kill('SIGKILL')).toBe(true);
    await until(() => group.keeper.exitCode !== null || group.keeper.signalCode !== null, Boolean);
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
    expect(() => process.kill(marker(group, 'grandchild')!.pid, 0)).not.toThrow();
    for (const role of ['root', 'harness', 'child', 'grandchild']) release(group, role);
    await delay(700);
    expect(existsSync(evidence(group, 'drain-receipt.json'))).toBe(false);
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
    expect(() => assertExecutionWritersDrained(group.storePath, group.root, group.dispatchId, group.instanceId))
      .toThrow(/recovery denied/);
  });

  it('Runner hard loss leaves Harness and descendants ALIVE until the last member exits', async () => {
    const group = await start();
    const runnerPid = marker(group, 'root')!.pid;
    const grandchildPid = marker(group, 'grandchild')!.pid;
    process.kill(runnerPid, 'SIGKILL');
    const alive = await until(() => observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId),
      (value) => value.state === 'ALIVE' && value.process_ids.includes(grandchildPid)
        && !value.process_ids.includes(runnerPid));
    expect(alive.state).toBe('ALIVE');
    expect(() => assertExecutionWritersDrained(group.storePath, group.root, group.dispatchId, group.instanceId))
      .toThrow(/recovery denied/);
    for (const role of ['harness', 'child', 'grandchild']) release(group, role);
    await until(() => existsSync(evidence(group, 'drain-receipt.json')), Boolean);
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('DRAINED');
  });

  it('an explicit CREATE_BREAKAWAY_FROM_JOB attempt cannot escape coverage', async () => {
    const group = await start(true);
    const result = await until(() => {
      try { return JSON.parse(readFileSync(join(group.root, 'breakaway.json'), 'utf8')) as
        { started: boolean; pid: number; error: number }; } catch { return undefined; }
    }, Boolean);
    if (!result) throw new Error('breakaway fixture produced no result');
    if (result.started) {
      const observation = await until(() => observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId),
        (value) => value.state === 'ALIVE' && value.process_ids.includes(result.pid));
      expect(observation.state).toBe('ALIVE');
    } else {
      expect(result.error).toBeGreaterThan(0);
    }
  });

  it('does not execute Runner before sealed Job assignment and explicit resume', async () => {
    const group = await start(false, 'before_resume');
    const gate = join(group.root, 'before-resume');
    await until(() => existsSync(gate + '.ready'), Boolean);
    expect(JSON.parse(readFileSync(evidence(group, 'runtime.sealed.json'), 'utf8')).state).toBe('SEALED');
    expect(existsSync(evidence(group, 'runtime.resumed.json'))).toBe(false);
    expect(readExecutionWitness(group.storePath, group.root, group.dispatchId, group.instanceId)).toBeUndefined();
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
    expect(existsSync(join(group.root, 'root.json'))).toBe(false);
    writeFileSync(gate + '.go', 'resume\n', { flag: 'wx' });
    const witness = waitForExecutionWitness(group.storePath, group.root, group.dispatchId, group.instanceId);
    expect(witness?.state).toBe('RESUMED');
    await until(() => existsSync(join(group.root, 'root.json')), Boolean);
  });

  it('zero observed but Keeper lost before receipt remains UNKNOWN', async () => {
    const group = await start(false, 'before_receipt');
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('ALIVE');
    for (const role of ['root', 'harness', 'child', 'grandchild']) release(group, role);
    await until(() => group.keeper.exitCode !== null, Boolean);
    expect(group.keeper.exitCode).toBe(91);
    expect(existsSync(evidence(group, 'drain-receipt.json'))).toBe(false);
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
  });

  it('rejects pre-existing sealed evidence before it can create a Runner', () => {
    const root = tempDir('eng-mcp-sealed-conflict-');
    try {
      const storePath = join(root, 'ledger.sqlite');
      const dispatchId = randomUUID();
      const instanceId = randomUUID();
      expect(reserveExecutionWitness(storePath, dispatchId, instanceId)).toBe(true);
      writeFileSync(executionEvidencePath(storePath, dispatchId, 'runtime.sealed.json'), '{}');
      const result = spawnSync(EXECUTION_KEEPER_EXE,
        ['launch', executionWitnessPath(storePath, dispatchId), process.execPath, fixture,
          storePath, root, dispatchId, instanceId], { windowsHide: true, encoding: 'utf8' });
      expect(result.status).toBe(90);
      expect(existsSync(join(root, 'root.json'))).toBe(false);
      expect(reserveExecutionWitness(storePath, dispatchId, randomUUID())).toBe(false);
    } finally { removeDir(root); }
  });

  it('rejects stale dispatch binding and malformed Keeper evidence', async () => {
    const group = await start();
    const sealedPath = evidence(group, 'runtime.sealed.json');
    const original = readFileSync(sealedPath, 'utf8');
    const sealed = JSON.parse(original);
    sealed.dispatch_run_id = randomUUID();
    writeFileSync(sealedPath, JSON.stringify(sealed));
    expect(readExecutionWitness(group.storePath, group.root, group.dispatchId, group.instanceId)).toBeUndefined();
    writeFileSync(sealedPath, '{');
    expect(observeExecutionGroup(group.storePath, group.root, group.dispatchId, group.instanceId).state)
      .toBe('UNKNOWN');
  });
});
