import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/trusted-runtime-closure.mjs', import.meta.url));

describe('accepted trusted runtime closure', () => {
  it('contains the controller, Git binding and verifier, with no nonliteral resolution', () => {
    const result = JSON.parse(execFileSync(process.execPath, [script], {
      encoding: 'utf8', windowsHide: true,
    })) as { paths: string[]; nonliteral: unknown[]; yamlCliDisposition: string };
    const normalized = result.paths.map((path) => path.replaceAll('\\', '/'));
    expect(normalized.some((path) => path.endsWith('/dist/orchestration/c2c-launch-controller.js'))).toBe(true);
    expect(normalized.some((path) => path.endsWith('/dist/orchestration/trusted-runtime.js'))).toBe(true);
    expect(normalized.some((path) => path.endsWith('/dist/trusted-git.js'))).toBe(true);
    expect(normalized.some((path) => path.endsWith('/dist/orchestration/worker-runner-entry.js'))).toBe(true);
    for (const name of ['execution-bootstrap', 'execution-keeper', 'execution-worker', 'authority-git', 'execution-security']) {
      expect(normalized.some((path) => path.endsWith(`/dist/native/${name}.exe`))).toBe(true);
    }
    expect(result.nonliteral).toEqual([]);
    expect(result.yamlCliDisposition).toBe('NOT_IN_ACCEPTED_RUNTIME_CLOSURE');
    expect(normalized.some((path) => path.endsWith('/node_modules/yaml/dist/cli.mjs'))).toBe(false);
    const yamlPackage = normalized.find((path) => path.endsWith('/node_modules/yaml/package.json'));
    expect(yamlPackage).toBeTruthy();
    const exports = (JSON.parse(readFileSync(yamlPackage!, 'utf8')) as { exports: Record<string, unknown> }).exports;
    expect(Object.keys(exports)).not.toContain('./cli');
  });
});
