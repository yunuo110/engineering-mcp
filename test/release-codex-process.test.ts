import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as launcher from '../src/adapters/codex-launcher.ts';
import { CodexExecAdapter } from '../src/adapters/codex-exec-adapter.ts';
import { createTask } from '../src/lifecycle.ts';
import { implPayload, initGitRepo, openTempStore, removeDir, snapshot, tempDir } from './helpers.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.skipIf(process.platform !== 'win32').each([0, 7])('executes a real cmd wrapper with metacharacters in repository path and process exit %s', async (exitCode) => {
  const repo = initGitRepo();
  const scripts = tempDir('eng-mcp-cmd-');
  const cwd = join(repo, 'repo&echo.INJECTED&rem');
  mkdirSync(cwd);
  const opened = openTempStore(repo);
  try {
    const capture = join(scripts, 'capture.json');
    const worker = join(scripts, 'worker.cjs');
    writeFileSync(worker, `const fs = require('node:fs'); let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
      const i = process.argv.indexOf('--output-last-message');
      if (i >= 0) fs.writeFileSync(process.argv[i+1], JSON.stringify({ outcome: 'completed', summary: 'done', changed_files: [], validation: [], known_limitations: [], exit_code: 0 }));
      process.exitCode = ${exitCode};
    });`);
    const wrapper = join(scripts, 'codex.cmd');
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${worker}" %*\r\n`);
    vi.spyOn(launcher, 'resolveCodexLauncher').mockReturnValue({ kind: 'cmd', executable: wrapper, displayPath: wrapper });
    vi.stubEnv('ENGINEERING_MCP_CODEX_STUB', '0');
    const task = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const result = await new CodexExecAdapter().execute({ dispatchRunId: task.id, taskId: task.id, repositoryRoot: cwd, baseCommit: task.base_commit, task });
    const recorded = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; input: string };
    expect(recorded.argv[recorded.argv.indexOf('-C') + 1]).toBe(cwd);
    expect(recorded.input).toContain('"exit_code"');
    expect(result.exit_code).toBe(exitCode);
    expect(result.outcome).toBe(exitCode === 0 ? 'completed' : 'blocked');
  } finally {
    opened.store.close();
    for (const dir of [opened.dir, scripts, repo]) removeDir(dir);
  }
});
