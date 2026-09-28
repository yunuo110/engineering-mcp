import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { executeC2CPlan } from '../src/c2c/controller.ts';
import { Store } from '../src/store.ts';
import { builtinWorkerProfiles } from '../src/worker-profiles.ts';
import { DatabaseSync } from 'node:sqlite';

// TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE.
// All extraction/build/execution is in a disposable test directory.
// No installed foundation path, production DB, account, ACL, real Bridge, or model is accessed.
const directory = mkdtempSync(join(tmpdir(), 'engineering-ingress-offline-'));
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const encoded = readFileSync(new URL('./fixtures/portable-legacy/source-capsule.b64', import.meta.url), 'utf8').replace(/\s/g, '');
const raw = inflateSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 1024 * 1024 });
const sanitizedFixtureDigest = '286e1b39db898757e032d32ae1061763cb7788afa50672fee9a4f353acadb841';
if (createHash('sha256').update(raw).digest('hex') !== sanitizedFixtureDigest) throw new Error('SANITIZED_INGRESS_SOURCE_CAPSULE_CHANGED');
const files = JSON.parse(raw.toString('utf8')) as Record<string, string>;
const patch = JSON.parse(readFileSync(new URL('./fixtures/portable-legacy/source-edits.json', import.meta.url), 'utf8')) as { schema: string; edits: Array<{path: string; old: string; new: string}> };
if (patch.schema !== 'engineering-ingress-reviewed-text-edits/1') throw new Error('SOURCE_EDIT_SCHEMA');
for (const e of patch.edits) {
  if (!Object.hasOwn(files, e.path) || !e.old || files[e.path]!.split(e.old).length !== 2) throw new Error('SOURCE_EDIT_NOT_EXACT');
  files[e.path] = files[e.path]!.replace(e.old, e.new);
}
files['src/BrokerMain.cs'] = readFileSync(new URL('./fixtures/portable-legacy/BrokerMain.cs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
for (const [relative, content] of Object.entries(files)) {
  if (!/^(src|bridge|ops|tests)\/[A-Za-z0-9.-]+$/.test(relative) || relative.includes('..')) throw new Error('CAPSULE_PATH_REJECTED');
  const path = join(directory, ...relative.split('/')); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content);
}
const request = () => ({ plan_message: { protocol_version: 'engineering-c2c/1', message_id: 'ingress-nonexistent-message', task_id: 'ingress-nonexistent-task', sender_role: 'OWNER', state: 'PLAN', expected_revision: 1 }, acceptance_command_id: 'same-accept', delegation_command_id: 'same-delegation', worker_profile_id: 'trusted-opaque-name' });

describe('C2C ingress V1 sanitized isolated regression', () => {
  it('has exact sanitized fixture bytes and no binary executable payload', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(sanitizedFixtureDigest);
    expect(Object.keys(files).some((p) => p.endsWith('.exe'))).toBe(false);
    expect(files['src/Bindings.cs.in']).toBe(readFileSync(new URL('./fixtures/portable-legacy/Bindings.cs.in', import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
    expect(files['src/Bindings.cs.in']).toContain('S-1-5-21-111-222-333-1006');
    expect(files['src/Bindings.cs.in']).toContain('C:\\FixtureRoot\\ledger.sqlite');
    expect(files['src/ReleaseGuard.cs']).toContain('Environment.MachineName!="FIXTURE_HOST"');
    expect(JSON.stringify(patch)).toContain('C:\\\\FixtureRoot\\\\denied-secret.xml');
  });
  it('compiles all C# production entrypoints and runs real Windows synthetic protocol/pipe/job tests', () => {
    expect(process.platform).toBe('win32');
    const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const template = files['src/Bindings.cs.in']!;
    writeFileSync(join(directory, 'Bindings.cs'), template.replace('@@BRIDGE_SID@@', 'S-1-5-21-111-222-333-999').replace('@@CONTROLLER_HOME@@', homedir()).replace('@@INGRESS_ROOT@@', directory));
    const cs = Object.keys(files).filter((p) => p.startsWith('src/') && p.endsWith('.cs')).map((p) => join(directory, ...p.split('/')));
    const common = ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', ...cs, join(directory, 'Bindings.cs')];
    const exe = join(directory, 'SyntheticTests.exe');
    execFileSync(csc, ['/main:IngressTests', `/out:${exe}`, ...common, join(directory, 'tests', 'Tests.cs')], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
    for (const main of ['EngineeringIngress.BrokerMain', 'EngineeringIngress.PipeClientMain']) {
      execFileSync(csc, [`/main:${main}`, `/out:${join(directory, main + '.exe')}`, ...common], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
    }
    const output = execFileSync(exe, [], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 45000 });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ status: 'PASS', real_controller_calls: 0, model_calls: 0, production_ledger_access: 0, live_cross_account_proof: 'NOT_RUN' });
    expect(result.tests).toBeGreaterThanOrEqual(40);
    console.log('WINDOWS_SYNTHETIC_INGRESS', JSON.stringify(result));
  }, 120000);
  it('refuses an unstaged source controller before the disposable ledger is opened', () => {
    const repoPath = join(directory, 'runtime-repo'); mkdirSync(repoPath);
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
    execFileSync(git, ['init', '--quiet'], { cwd: repoPath, windowsHide: true, shell: false });
    writeFileSync(join(repoPath, 'README.md'), 'Disposable ingress test only\n');
    execFileSync(git, ['add', 'README.md'], { cwd: repoPath, windowsHide: true, shell: false });
    execFileSync(git, ['-c', 'user.name=Ingress Test', '-c', 'user.email=ingress-test@example.invalid', 'commit', '--quiet', '-m', 'test baseline'], { cwd: repoPath, windowsHide: true, shell: false });
    const repo = realpathSync(repoPath); const dbPath = join(directory, 'real-stdio-test.sqlite');
    // Protected mode must reject a source checkout before either Core or the
    // frozen ingress child can make a disposable ledger authoritative.
    const entry = new URL('../src/index.ts', import.meta.url);
    const coreEntry = decodeURIComponent(entry.pathname).replace(/^\//, '');
    const direct = spawnSync(process.execPath, [coreEntry, '--role', 'owner', '--enable-c2c-controller', '--repo', repo, '--db', dbPath], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toMatch(/TRUSTED_RUNTIME|protected|manifest/i);
    const ingress = spawnSync(join(directory, 'SyntheticTests.exe'), ['controller-smoke', process.execPath, coreEntry, repo, dbPath], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    expect(ingress.status).not.toBe(0);
    expect(ingress.stderr).toContain('CHILD_STDOUT_CLOSED');
    expect(existsSync(dbPath)).toBe(false);
    console.log('WINDOWS_TESTED_SOURCE_SHA256', JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,c]) => [p, createHash('sha256').update(c).digest('hex')]))));
  }, 45000);
  it('Bridge validates fixed input and UTF8 limits without invoking its fixed native client', async () => {
    const contract = await import(pathToFileURL(join(directory, 'bridge', 'contract.mjs')).href);
    expect(JSON.parse(contract.boundedRequest(request(), z))).toEqual(request());
    for (const key of ['tool', 'method', 'repo', 'db', 'argv', 'cwd', 'environment', 'actor_role', 'manifest']) {
      expect(() => contract.boundedRequest({ ...request(), [key]: 'untrusted' }, z)).toThrow();
    }
    const r = request(); Object.assign(r.plan_message, { goal: '中'.repeat(16000), rationale: '中'.repeat(16000) });
    expect(() => contract.boundedRequest(r, z)).toThrow('C2C_REQUEST_SIZE_LIMIT');
    expect(contract.responseEnvelope('{"status":"UNKNOWN","code":"private","retry":"RETRY_WITH_SAME_IDENTITIES"}')).toEqual(contract.uncertain());
    expect(() => contract.responseEnvelope('{"method":"tools/call"}')).toThrow();
  });
  it('read-only ledger report keeps PASS distinct from task-status aggregates and import does not probe production', async () => {
    const helper = await import(pathToFileURL(join(directory, 'ops', 'ledger-preflight.mjs')).href);
    const aggregates = { schema: 12, status: { CLOSED: 4 }, counts: { tasks: 4, task_events: 14 } };
    expect(helper.resultEnvelope(aggregates, { device: 'synthetic', file_index: 'synthetic' })).toMatchObject({ status: 'PASS', ledger: aggregates, file_identity: { device: 'synthetic', file_index: 'synthetic' } });
  });
  it('current frozen controller rejects a missing task with zero durable rows in a disposable Store', () => {
    const dbPath = join(directory, 'test-only.sqlite');
    const repo = join(directory, 'ledger-repo'); mkdirSync(repo, { recursive: true });
    const store = Store.open(dbPath, { repoRoot: repo });
    try {
      const result = executeC2CPlan({ processRole: 'owner', enableC2CController: true, repoPath: repo, store, workerProfiles: builtinWorkerProfiles() }, request());
      expect(result).toMatchObject({ ok: false, stage: 'evaluation', error: { code: 'TASK_MISMATCH' } });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { for (const name of ['tasks', 'task_events', 'dispatch_runs', 'c2c_evaluation_receipts', 'c2c_plan_acceptance_receipts', 'c2c_delegation_receipts']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).toEqual({ n: 0 }); }
      finally { db.close(); }
    } finally { store.close(); }
  });
  it('does not turn timeout into Engineering cancellation, expose provider branches, or load production DB from Bridge', () => {
    const bridge = files['bridge/c2c-forwarding.mjs']!;
    expect(bridge).not.toMatch(/DatabaseSync|Store\.open|tools\/call|Grok|Codex|Luna|GenericCli/);
    expect(bridge).toContain('spawn(CLIENT_PATH, []');
    expect(files['src/McpChild.cs']).not.toMatch(/"notifications\/cancelled"|"recover_task"|"resume_task"|"cancel_task"|"create_task"/);
    expect(files['src/WindowsBoundary.cs']).toContain('ClientAccess=0x00120003');
    expect(files['src/WindowsBoundary.cs']).toContain('0x00120083;;;"+bridge');
    expect(files['src/WindowsBoundary.cs']).toContain('PipeMode=8');
  });
});
