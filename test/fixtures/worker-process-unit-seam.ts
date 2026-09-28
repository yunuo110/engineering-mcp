import { spawn } from 'node:child_process';
import { vi } from 'vitest';

// Test-only process seam for adapter protocol fixtures. This deliberately does
// not assert a Windows SID, Job membership, ACL or protected runtime binding.
// Real Worker-boundary acceptance must use a separately provisioned host.
vi.mock('../../src/orchestration/restricted-worker-launch.ts', async (original) => ({
  ...await original<typeof import('../../src/orchestration/restricted-worker-launch.ts')>(),
  spawnRestrictedWorker: vi.fn((executable: string, args: string[], options: {
    cwd: string; shell: false; windowsHide: true; windowsVerbatimArguments?: true;
  }) => spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })),
}));
