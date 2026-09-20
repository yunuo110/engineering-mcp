import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyConfigurePlanIdentity,
  ConfigureError,
  createConfigurePlanIdentity,
  prepareConfigure,
  type ConfigureErrorCode,
} from '../src/configure.ts';
import { initGitRepo, tempDir } from './helpers.ts';

const childPath = fileURLToPath(new URL('./fixtures/configure-transaction-child.ts', import.meta.url));
const configureSourcePath = fileURLToPath(new URL('../src/configure.ts', import.meta.url));
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(source: string | null = 'setting = "source"\n'): {
  repo: string;
  root: string;
  config: string;
  identity: string;
  proposed: string;
} {
  const repo = initGitRepo();
  const root = tempDir('eng-mcp-config-transaction-');
  const config = join(root, 'config.toml');
  cleanup.push(repo, root);
  if (source !== null) writeFileSync(config, source);
  const prepared = prepareConfigure({ host: 'codex', configPath: config, repo, cwd: repo });
  return {
    repo,
    root,
    config,
    identity: createConfigurePlanIdentity(prepared).identity,
    proposed: prepared.proposedContent,
  };
}

function expectConfigureError(run: () => unknown, code: ConfigureErrorCode): ConfigureError {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigureError);
    expect((error as ConfigureError).code).toBe(code);
    return error as ConfigureError;
  }
}

function startChild(identity: string, boundary = 'none'): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [childPath, identity, boundary], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForBoundary(child: ChildProcessWithoutNullStreams, boundary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${boundary}: ${output}`)), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(`BOUNDARY:${boundary}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ${boundary} with ${code}: ${output}`));
    });
  });
}

function finishChild(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('\n');
  });
}

function releaseBoundary(child: ChildProcessWithoutNullStreams): void {
  child.stdin.write('\n');
}

function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.on('close', () => resolve());
    child.kill();
  });
}

describe('Safe Configure capture-then-create transaction', () => {
  it('contains no overwrite/delete cleanup primitive or persistent plan-secret subsystem', () => {
    const source = readFileSync(configureSourcePath, 'utf8');
    expect(source).not.toMatch(/\b(?:renameSync|unlinkSync|rmSync|rmdirSync|createHmac)\b/);
    expect(source).not.toContain('ENGINEERING_MCP_CONFIGURE_STATE_DIR');
    expect(source).not.toContain('secret.key');
    expect(source).toContain("linkSync(sourcePath, targetPath)");
  });

  it('captures an external write immediately before move, restores it create-if-absent, and invalidates the plan', async () => {
    const item = fixture();
    const external = Buffer.from('setting = "external-before-capture"\n');
    const child = startChild(item.identity, 'before-capture');
    await waitForBoundary(child, 'before-capture');
    writeFileSync(item.config, external);
    const result = await finishChild(child);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('CONFIGURE_PLAN_INVALIDATED');
    expect(readFileSync(item.config)).toEqual(external);
    const report = JSON.parse(result.stdout.trim()) as {
      error: {
        details: {
          expected_source_hash: string;
          proposed_hash: string;
          artifacts: Array<{ path: string; hash: string; classification: string; identity: object }>;
        };
      };
    };
    expect(report.error.details.expected_source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.error.details.proposed_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.error.details.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'EXTERNAL' }),
      expect.objectContaining({ classification: 'PROPOSED' }),
    ]));
    expect(report.error.details.artifacts.every((artifact) => artifact.path && artifact.hash && artifact.identity)).toBe(true);
  });

  it('never overwrites a target recreated after capture', async () => {
    const item = fixture();
    const external = Buffer.from('setting = "recreated"\n');
    const child = startChild(item.identity, 'after-capture');
    await waitForBoundary(child, 'after-capture');
    expect(existsSync(item.config)).toBe(false);
    writeFileSync(item.config, external);
    const result = await finishChild(child);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('CONFIGURE_MANUAL_RECOVERY_REQUIRED');
    expect(readFileSync(item.config)).toEqual(external);
  });

  it('never overwrites a first-install target created before install', async () => {
    const item = fixture(null);
    const external = Buffer.from('setting = "first-install-race"\n');
    const child = startChild(item.identity, 'before-install');
    await waitForBoundary(child, 'before-install');
    writeFileSync(item.config, external);
    const result = await finishChild(child);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('CONFIGURE_MANUAL_RECOVERY_REQUIRED');
    expect(readFileSync(item.config)).toEqual(external);
  });

  for (const boundary of ['before-capture', 'after-capture', 'after-install'] as const) {
    it(`recovers by exact retry after process termination at ${boundary}`, async () => {
      const item = fixture();
      const child = startChild(item.identity, boundary);
      await waitForBoundary(child, boundary);
      await terminateChild(child);

      const result = applyConfigurePlanIdentity(item.identity);
      expect(result.mode).toBe(boundary === 'before-capture' ? 'APPLIED' : 'ALREADY_APPLIED');
      expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
      expect(result.backup_path).not.toBeNull();
    });
  }

  it('allows only one competing installation and never loses the captured source', async () => {
    const item = fixture();
    const first = startChild(item.identity);
    const second = startChild(item.identity);
    const [left, right] = await Promise.all([finishChild(first), finishChild(second)]);

    expect([left.code, right.code].filter((code) => code === 0).length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    const replay = applyConfigurePlanIdentity(item.identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expect(readFileSync(replay.backup_path!, 'utf8')).toBe('setting = "source"\n');
  });

  it('deterministically reconciles P1 installing P before P2 captures P', async () => {
    const item = fixture();
    const first = startChild(item.identity, 'before-capture');
    const second = startChild(item.identity, 'before-capture,after-capture');
    await Promise.all([
      waitForBoundary(first, 'before-capture'),
      waitForBoundary(second, 'before-capture'),
    ]);

    const firstResult = await finishChild(first);
    expect(firstResult.code).toBe(0);
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    const secondCaptured = waitForBoundary(second, 'after-capture');
    releaseBoundary(second);
    await secondCaptured;
    expect(existsSync(item.config)).toBe(false);
    const secondResult = await finishChild(second);

    expect(secondResult.code).toBe(0);
    expect(secondResult.stdout).toContain('ALREADY_APPLIED');
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    const replay = applyConfigurePlanIdentity(item.identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expect(replay.artifacts.some((artifact) => artifact.classification === 'SOURCE')).toBe(true);
    expect(replay.artifacts.some((artifact) => artifact.classification === 'PROPOSED')).toBe(true);
    expect(replay.artifacts.every((artifact) => artifact.path && artifact.hash && artifact.identity)).toBe(true);
  });

  it('restores a captured same-plan proposal after P2 is killed immediately after capture', async () => {
    const item = fixture();
    const first = startChild(item.identity, 'before-capture');
    const second = startChild(item.identity, 'before-capture,after-capture');
    await Promise.all([
      waitForBoundary(first, 'before-capture'),
      waitForBoundary(second, 'before-capture'),
    ]);
    expect((await finishChild(first)).code).toBe(0);
    const secondCaptured = waitForBoundary(second, 'after-capture');
    releaseBoundary(second);
    await secondCaptured;
    await terminateChild(second);
    expect(existsSync(item.config)).toBe(false);

    const recovered = applyConfigurePlanIdentity(item.identity);
    expect(recovered.mode).toBe('ALREADY_APPLIED');
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    expect(recovered.artifacts.some((artifact) => artifact.classification === 'SOURCE')).toBe(true);
    expect(recovered.artifacts.some((artifact) => artifact.classification === 'PROPOSED')).toBe(true);
    const backupContents = readdirSync(item.root)
      .filter((name) => name.endsWith('.bak'))
      .map((name) => readFileSync(join(item.root, name), 'utf8'));
    expect(backupContents).toContain('setting = "source"\n');
    expect(backupContents).toContain(item.proposed);
  });

  it('preserves external B when it appears during recovery of captured P', async () => {
    const item = fixture();
    const first = startChild(item.identity, 'before-capture');
    const second = startChild(item.identity, 'before-capture,after-capture');
    await Promise.all([
      waitForBoundary(first, 'before-capture'),
      waitForBoundary(second, 'before-capture'),
    ]);
    expect((await finishChild(first)).code).toBe(0);
    const secondCaptured = waitForBoundary(second, 'after-capture');
    releaseBoundary(second);
    await secondCaptured;
    await terminateChild(second);

    const recovery = startChild(item.identity, 'before-install');
    await waitForBoundary(recovery, 'before-install');
    const external = Buffer.from('setting = "external-B"\n');
    writeFileSync(item.config, external);
    const result = await finishChild(recovery);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('CONFIGURE_MANUAL_RECOVERY_REQUIRED');
    expect(readFileSync(item.config)).toEqual(external);
    const report = JSON.parse(result.stdout.trim()) as {
      error: { details: { artifacts: Array<{ classification: string; path: string; hash: string; identity: object }> } };
    };
    expect(report.error.details.artifacts.some((artifact) => artifact.classification === 'SOURCE')).toBe(true);
    expect(report.error.details.artifacts.some((artifact) => artifact.classification === 'PROPOSED')).toBe(true);
    expect(report.error.details.artifacts.every((artifact) => artifact.path && artifact.hash && artifact.identity)).toBe(true);
  });

  it('passes repeated deterministic same-plan capture stress', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const item = fixture(`setting = "source-${attempt}"\n`);
      const first = startChild(item.identity, 'before-capture');
      const second = startChild(item.identity, 'before-capture');
      await Promise.all([
        waitForBoundary(first, 'before-capture'),
        waitForBoundary(second, 'before-capture'),
      ]);
      expect((await finishChild(first)).code).toBe(0);
      const secondResult = await finishChild(second);
      expect(secondResult.code).toBe(0);
      expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
      expect(applyConfigurePlanIdentity(item.identity).mode).toBe('ALREADY_APPLIED');
    }
  }, 120_000);

  it('keeps capability probes outside replay authority and transaction evidence', () => {
    const item = fixture();
    const applied = applyConfigurePlanIdentity(item.identity);
    expect(applied.mode).toBe('APPLIED');

    const initialProbeNames = readdirSync(item.root)
      .filter((name) => name.includes('.linkcheck.'))
      .sort();
    expect(initialProbeNames.length).toBeGreaterThan(0);
    expect(applied.retained_artifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    expect(applied.artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);

    writeFileSync(join(item.root, initialProbeNames[0]!), 'tampered capability probe\n');
    let replay = applyConfigurePlanIdentity(item.identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    expect(replay.retained_artifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    expect(replay.artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);

    for (const name of readdirSync(item.root).filter((entry) => entry.includes('.linkcheck.'))) {
      rmSync(join(item.root, name));
    }
    replay = applyConfigurePlanIdentity(item.identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);

    const capabilityMarker = '.linkcheck.';
    const markerEnd = initialProbeNames[0]!.indexOf(capabilityMarker) + capabilityMarker.length;
    const probePrefix = initialProbeNames[0]!.slice(0, markerEnd);
    writeFileSync(join(item.root, `${probePrefix}000-source-bytes`), 'setting = "source"\n');
    writeFileSync(join(item.root, `${probePrefix}zzz-proposed-bytes`), item.proposed);

    replay = applyConfigurePlanIdentity(item.identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    expect(replay.retained_artifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    expect(replay.artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);
  });

  it('reconstructs a real proposal instead of recovering from a proposed-hash capability probe', () => {
    const item = fixture();
    expectConfigureError(
      () => applyConfigurePlanIdentity(item.identity, {
        hooks: { afterCapture: () => { throw new Error('retain crash state for probe isolation'); } },
      }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(existsSync(item.config)).toBe(false);

    const probeNames = readdirSync(item.root)
      .filter((name) => name.includes('.linkcheck.'))
      .sort();
    const proposalNames = readdirSync(item.root)
      .filter((name) => name.includes('.proposed.'))
      .sort();
    expect(probeNames.length).toBeGreaterThan(0);
    expect(proposalNames.length).toBeGreaterThan(0);

    for (const name of proposalNames) rmSync(join(item.root, name));

    const recovered = applyConfigurePlanIdentity(item.identity);
    expect(readFileSync(item.config, 'utf8')).toBe(item.proposed);
    expect(recovered.proposed_path).not.toContain('.linkcheck.');
    expect(recovered.retained_artifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    expect(recovered.artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);
  });

  describe.skipIf(process.platform !== 'win32')('object-bound final installation', () => {
    it('never activates same-length proposal bytes changed at the final boundary', () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const item = fixture(`setting = "source-final-bytes-${attempt}"\n`);
        const error = expectConfigureError(
          () => applyConfigurePlanIdentity(item.identity, {
            hooks: {
              beforeHardLink: ({ kind, sourcePath }) => {
                if (kind !== 'INSTALL') return;
                writeFileSync(sourcePath, Buffer.alloc(readFileSync(sourcePath).length, 0x78));
              },
            },
          }),
          'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
        );
        expect(error.message).toContain('occupied the target');
        expect(existsSync(item.config)).toBe(false);
      }
    });

    it('never activates a replacement proposal object at the final boundary', () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const item = fixture(`setting = "source-final-object-${attempt}"\n`);
        expectConfigureError(
          () => applyConfigurePlanIdentity(item.identity, {
            hooks: {
              beforeHardLink: ({ kind, sourcePath }) => {
                if (kind !== 'INSTALL') return;
                const size = readFileSync(sourcePath).length;
                rmSync(sourcePath);
                writeFileSync(sourcePath, Buffer.alloc(size, 0x79));
              },
            },
          }),
          'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
        );
        expect(existsSync(item.config)).toBe(false);
      }
    });

    it('preserves external B created at the final object-bound link boundary', () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const item = fixture(`setting = "source-final-target-${attempt}"\n`);
        const external = Buffer.from(`setting = "external-final-${attempt}"\n`);
        expectConfigureError(
          () => applyConfigurePlanIdentity(item.identity, {
            hooks: {
              beforeHardLink: ({ kind, targetPath }) => {
                if (kind === 'INSTALL') writeFileSync(targetPath, external);
              },
            },
          }),
          'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
        );
        expect(readFileSync(item.config)).toEqual(external);
      }
    });
  });

  it('reports complete State-E evidence on every exact retry', async () => {
    const item = fixture();
    const child = startChild(item.identity, 'after-capture');
    await waitForBoundary(child, 'after-capture');
    await terminateChild(child);
    const sourceBackup = readdirSync(item.root)
      .map((name) => join(item.root, name))
      .find((path) => path.endsWith('.bak'))!;
    writeFileSync(sourceBackup, 'setting = "external-retained"\n');

    for (let retry = 0; retry < 2; retry += 1) {
      const error = expectConfigureError(
        () => applyConfigurePlanIdentity(item.identity),
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
      );
      expect(error.details).toMatchObject({
        config_path: item.config,
        expected_source_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        proposed_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        current_target: { state: 'MISSING', hash: null },
      });
      const artifacts = error.details!.artifacts as Array<{
        path: string;
        hash: string;
        classification: string;
        kind: string;
        identity: object;
        authorization: { fingerprint: string } | null;
      }>;
      const retainedArtifacts = error.details!.retained_artifacts as string[];
      expect(artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ classification: 'EXTERNAL', kind: 'BACKUP' }),
        expect.objectContaining({ classification: 'PROPOSED', kind: 'PROPOSED' }),
      ]));
      expect(artifacts.every((artifact) =>
        artifact.path && artifact.hash && artifact.kind && artifact.identity && artifact.authorization?.fingerprint,
      )).toBe(true);
      expect(artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);
      expect(retainedArtifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    }
  });

  it('fails closed before capture when hard-link create-if-absent is unavailable', () => {
    const item = fixture();
    expectConfigureError(
      () => applyConfigurePlanIdentity(item.identity, {
        hooks: {
          beforeHardLink: ({ kind }) => {
            if (kind === 'CAPABILITY_CHECK') throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' });
          },
        },
      }),
      'CONFIGURE_UNSUPPORTED',
    );
    expect(readFileSync(item.config, 'utf8')).toBe('setting = "source"\n');
  });
});
