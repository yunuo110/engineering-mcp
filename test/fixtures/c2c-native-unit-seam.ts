import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { vi } from 'vitest';
import type { TrustedRuntimeBinding } from '../../src/orchestration/trusted-runtime.ts';
import { validateIdentityFrame } from '../../src/orchestration/development-identity-channel.ts';

// Vitest-only native boundary. No process, identity, ACL or Job is created here.
// Store transactions, witness reservation files, Runner and lifecycle stay real.
const seam = vi.hoisted(() => ({
  spawn: undefined as undefined | ((command: string, args: string[], options: SpawnOptions) => ChildProcess),
  worker: undefined as undefined | ((executable: string, args: string[], options: { cwd: string; shell: false; windowsHide: true }) => ChildProcessWithoutNullStreams),
  binding: undefined as TrustedRuntimeBinding | undefined,
  preflightError: undefined as Error | undefined,
  witness: undefined as undefined | ((store: string, repo: string, dispatch: string, instance: string) => unknown),
  protectedMode: false,
  credentialFrame: undefined as Buffer | undefined,
  credentialError: undefined as Error | undefined,
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn((command: string, args: string[], options: SpawnOptions) => {
    if (!seam.spawn) throw new Error('Unit native spawn was not configured');
    return seam.spawn(command, args, options);
  }),
}));
vi.mock('../../src/orchestration/trusted-runtime.ts', async (original) => ({
  ...await original<typeof import('../../src/orchestration/trusted-runtime.ts')>(),
  verifyTrustedRuntime: vi.fn(() => {
    if (seam.preflightError) throw seam.preflightError;
    if (!seam.binding) throw new Error('Unit runtime binding was not configured');
    return seam.binding;
  }),
  isProtectedExecutionMode: vi.fn(() => seam.protectedMode),
}));
vi.mock('../../src/orchestration/production-credential.ts', () => ({
  acquireProductionIdentityFrame: vi.fn(() => {
    if (seam.credentialError) throw seam.credentialError;
    if (!seam.credentialFrame) throw new Error('Unit credential frame absent');
    const frame = seam.credentialFrame;
    seam.credentialFrame = undefined;
    try { validateIdentityFrame(frame); }
    catch (error) { frame.fill(0); throw error; }
    return frame;
  }),
}));
vi.mock('../../src/orchestration/witness-security.ts', async (original) => {
  const actual = await original<typeof import('../../src/orchestration/witness-security.ts')>();
  return { ...actual, witnessSecurity: vi.fn((...args: Parameters<typeof actual.witnessSecurity>) => {
    if (!seam.protectedMode) actual.witnessSecurity(...args);
  }) };
});
vi.mock('../../src/orchestration/execution-group.ts', async (original) => ({
  ...await original<typeof import('../../src/orchestration/execution-group.ts')>(),
  // Do not mock reservation or drain/admission. This observation is synthetic.
  waitForExecutionWitness: vi.fn((...args: [string, string, string, string]) => seam.witness?.(...args)),
}));
vi.mock('../../src/orchestration/restricted-worker-launch.ts', async (original) => ({
  ...await original<typeof import('../../src/orchestration/restricted-worker-launch.ts')>(),
  spawnRestrictedWorker: vi.fn((executable: string, args: string[], options: { cwd: string; shell: false; windowsHide: true }) => {
    if (!seam.worker) throw new Error('Unit Worker boundary was not configured');
    return seam.worker(executable, args, options);
  }),
}));

export type UnitBootstrapLaunch = {
  storePath: string; repoRoot: string; dispatchId: string; instanceId: string;
  child: ChildProcess; run(): Promise<void>; finished: Promise<void>;
};
type Fixture = {
  storePath: string; repoRoot: string;
  onRunner: (launch: UnitBootstrapLaunch) => void | Promise<void>;
  automatic?: boolean;
};
const fixtures = new Map<string, Fixture>();
export const unitBootstrap = {
  launches: [] as UnitBootstrapLaunch[],
  transfers: [] as Buffer[],
  attempts: 0,
  spawnError: undefined as Error | undefined,
  observed: true,
  errors: [] as unknown[],
  get preflightError() { return seam.preflightError; },
  set preflightError(value: Error | undefined) { seam.preflightError = value; },
};

export function syntheticIdentityFrame(): Buffer {
  // Four bounded fields; these are arbitrary unit bytes, not account secrets.
  const fields = [Buffer.from('unit-keeper'), Buffer.from('unit\0', 'utf16le'),
    Buffer.from('unit-worker'), Buffer.from('unit\0', 'utf16le')];
  return Buffer.concat(fields.flatMap((field) => {
    const length = Buffer.alloc(4); length.writeUInt32LE(field.length);
    return [length, field];
  }));
}

type SyntheticChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
};
export function syntheticChild(pid = 1234): SyntheticChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid, unref: vi.fn(), kill: vi.fn(() => true), exitCode: null, signalCode: null,
  }) as unknown as SyntheticChild;
}

export function configureUnitWorker(spawn: NonNullable<typeof seam.worker>): void { seam.worker = spawn; }
export function configureUnitProductionCredential(frame?: Buffer, error?: Error): void {
  seam.protectedMode = true; seam.credentialFrame = frame; seam.credentialError = error;
}

export function configureUnitBootstrap(fixture: Fixture): void {
  fixtures.set(fixture.storePath, fixture);
  const root = join(fixture.repoRoot, 'unit-runtime-not-executed');
  seam.binding = {
    root, bootstrapHelper: join(root, 'execution-bootstrap.exe'), nodePath: join(root, 'node.exe'),
    runnerEntry: join(root, 'c2c-worker-runner-entry.js'), keeperPath: join(root, 'execution-keeper.exe'),
    keeperSid: 'UNIT_ONLY_NOT_A_WINDOWS_SID',
    repositoryPath: fixture.repoRoot, ledgerPath: fixture.storePath,
  } as TrustedRuntimeBinding;
  seam.spawn = (command, args, options) => {
    unitBootstrap.attempts++;
    const binding = seam.binding!;
    if (command !== binding.bootstrapHelper || args[0] !== 'launch' || options.cwd !== binding.root
      || options.shell !== false || options.detached !== true)
      throw new Error('Unexpected native bootstrap invocation');
    if (unitBootstrap.spawnError) throw unitBootstrap.spawnError;
    const [storePath, repoRoot, dispatchId, instanceId] = args.slice(5, 9) as [string, string, string, string];
    const configured = fixtures.get(storePath);
    if (!configured || configured.repoRoot !== repoRoot) throw new Error('Unbound unit bootstrap fixture');
    const child = syntheticChild(4000 + unitBootstrap.launches.length);
    child.stdin.on('data', (chunk: Buffer) => { unitBootstrap.transfers.push(Buffer.from(chunk)); });
    (child.stdin as PassThrough).resume();
    let finish!: () => void;
    let running: Promise<void> | undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const launch: UnitBootstrapLaunch = { storePath, repoRoot, dispatchId, instanceId, child, finished,
      run() {
        return running ??= (async () => {
          try { await configured.onRunner(launch); }
          catch (error) { unitBootstrap.errors.push(error); }
          finally { child.emit('close', 0, null); finish(); }
        })();
      },
    };
    unitBootstrap.launches.push(launch);
    if (configured.automatic !== false) setImmediate(() => void launch.run());
    return child;
  };
  seam.witness = (store, repo, dispatch, instance) => {
    const launch = unitBootstrap.launches.find((item) => item.storePath === store && item.repoRoot === repo
      && item.dispatchId === dispatch && item.instanceId === instance);
    // Only controller's synchronous PID observation is under test here.
    return launch && unitBootstrap.observed ? { runner_pid: launch.child.pid } : undefined;
  };
}

export async function settleUnitBootstraps(): Promise<void> {
  await Promise.all(unitBootstrap.launches.map((launch) => launch.run()));
  if (unitBootstrap.errors.length) throw unitBootstrap.errors[0];
}
export function resetUnitBootstrap(): void {
  fixtures.clear(); unitBootstrap.launches.length = 0; unitBootstrap.attempts = 0;
  for (const frame of unitBootstrap.transfers.splice(0)) frame.fill(0);
  unitBootstrap.spawnError = undefined; unitBootstrap.observed = true; unitBootstrap.errors.length = 0;
  seam.spawn = undefined; seam.worker = undefined; seam.binding = undefined;
  seam.preflightError = undefined; seam.witness = undefined;
  seam.protectedMode = false; seam.credentialFrame?.fill(0);
  seam.credentialFrame = undefined; seam.credentialError = undefined;
}
