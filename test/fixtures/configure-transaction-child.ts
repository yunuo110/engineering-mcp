import { readSync } from 'node:fs';
import { applyConfigurePlanIdentity, ConfigureError, type ConfigureApplyHooks } from '../../src/configure.ts';

const identity = process.argv[2];
const boundaries = new Set((process.argv[3] ?? 'none').split(','));

if (!identity) throw new Error('configure plan identity is required');

function pause(name: string): void {
  if (!boundaries.has(name)) return;
  process.stdout.write(`BOUNDARY:${name}\n`);
  const byte = Buffer.alloc(1);
  while (readSync(0, byte, 0, 1, null) === 1 && byte[0] !== 0x0a) {
    // A newline releases exactly one deterministic transaction barrier.
  }
}

const hooks: ConfigureApplyHooks = {
  beforeCapture: () => pause('before-capture'),
  afterCapture: () => pause('after-capture'),
  beforeInstall: () => pause('before-install'),
  afterInstall: () => pause('after-install'),
};

try {
  const result = applyConfigurePlanIdentity(identity, { hooks });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  if (error instanceof ConfigureError) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } })}\n`,
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
