import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { isProtectedExecutionMode, verifyTrustedRuntime, assertProtectedRepositoryBinding } from './trusted-runtime.ts';
import { boundedControlEnvironment } from './runtime-environment.ts';

export function witnessSecurity(operation: 'root' | 'seal' | 'read', storePath: string,
  repoRoot: string, dispatchId: string): void {
  if (!isProtectedExecutionMode()) return; // Standard tests are not cross-SID security evidence.
  assertProtectedRepositoryBinding(storePath, repoRoot);
  const binding = verifyTrustedRuntime();
  const root = join(dirname(storePath), 'execution-witnesses');
  const output = execFileSync(binding.securityHelperPath, ['witness'], {
    input: JSON.stringify({ operation, root, dispatch: join(root, dispatchId),
      core: binding.coreSid, keeper: binding.keeperSid, operator: binding.operatorSid }),
    encoding: 'utf8', timeout: 30000, maxBuffer: 16384, windowsHide: true,
    env: boundedControlEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (output !== 'WITNESS_SECURITY_OK') throw new Error('WITNESS_SECURITY_REFUSED');
}
