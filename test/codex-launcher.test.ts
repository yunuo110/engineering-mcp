import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexLauncher } from '../src/adapters/codex-launcher.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-launcher-'));
  dirs.push(dir);
  return dir;
}

describe('codex launcher resolution', () => {
  it('prefers native codex.exe when present', () => {
    const dir = tempDir();
    const exe = join(dir, 'codex.exe');
    const cmd = join(dir, 'codex.cmd');
    writeFileSync(exe, 'native');
    writeFileSync(cmd, '@echo off');
    const launch = resolveCodexLauncher({
      platform: 'win32',
      where: (name) => (name === 'codex.exe' ? [exe] : name === 'codex.cmd' ? [cmd] : []),
    });
    expect(launch.kind).toBe('native');
    expect(launch.executable).toBe(exe);
  });

  it('uses codex.cmd when native is absent', () => {
    const dir = tempDir();
    const cmd = join(dir, 'codex.cmd');
    writeFileSync(cmd, '@echo off');
    const launch = resolveCodexLauncher({
      platform: 'win32',
      where: (name) => (name === 'codex.cmd' ? [cmd] : []),
    });
    expect(launch.kind).toBe('cmd');
    expect(launch.executable).toBe(cmd);
  });

  it('does not select an extensionless Unix shim on Windows', () => {
    const dir = tempDir();
    const shim = join(dir, 'codex');
    writeFileSync(shim, '#!/bin/sh');
    let shimReturned = false;
    const where = (name: string) => {
      if (name === 'codex') shimReturned = true;
      return name === 'codex' ? [shim] : [];
    };
    expect(() =>
      resolveCodexLauncher({
        platform: 'win32',
        where,
      }),
    ).toThrow();
    expect(shimReturned).toBe(false);
  });

  it('supports paths containing spaces', () => {
    const dir = tempDir();
    const sub = join(dir, 'Codex Tools');
    mkdirSync(sub, { recursive: true });
    const cmd = join(sub, 'codex.cmd');
    writeFileSync(cmd, '@echo off');
    const launch = resolveCodexLauncher({
      platform: 'win32',
      where: (name) => (name === 'codex.cmd' ? [cmd] : []),
    });
    expect(launch.kind).toBe('cmd');
    expect(launch.executable).toContain('Codex Tools');
  });

  it('fails closed when no valid Windows launcher exists', () => {
    expect(() =>
      resolveCodexLauncher({
        platform: 'win32',
        where: () => [],
      }),
    ).toThrow('No launchable Windows Codex wrapper found');
  });

  it('uses direct codex on non-Windows', () => {
    const launch = resolveCodexLauncher({ platform: 'linux' });
    expect(launch.kind).toBe('direct');
    expect(launch.executable).toBe('codex');
  });
});
