import { mkdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import { Store } from '../src/store.ts';
import { git, implPayload, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function write(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
}

type Scenario = {
  name: string;
  before?: Record<string, string>;
  writes?: Record<string, string>;
  deletes?: string[];
  rename?: [string, string];
  restoreTimes?: string;
  forbidden?: string[];
  blocked?: string[];
  observed?: string[];
};
const scenarios: Scenario[] = [
  { name: 'A: newly created ignored forbidden file', writes: { 'secret.env': 'secret' }, forbidden: ['secret.env'], blocked: ['secret.env'] },
  { name: 'B: new ignored file inside allowed scope', writes: { 'safe/result.bin': 'result' }, observed: ['safe/result.bin'] },
  { name: 'C: unchanged pre-existing ignored forbidden file', before: { 'secret.env': 'existing', 'cache/runtime.bin': 'existing' }, forbidden: ['secret.env'], observed: [] },
  { name: 'same-content ignored rewrite is not a net change', before: { 'secret.env': 'same' }, writes: { 'secret.env': 'same' }, forbidden: ['secret.env'], observed: [] },
  { name: 'D: modified ignored forbidden file', before: { 'secret.env': 'before' }, writes: { 'secret.env': 'after' }, forbidden: ['secret.env'], blocked: ['secret.env'] },
  { name: 'D: modified ignored file outside allowed scope without explicit prohibition', before: { 'cache/runtime.bin': 'before' }, writes: { 'cache/runtime.bin': 'after' }, blocked: ['cache/runtime.bin'] },
  { name: 'D: modified ignored allowed file', before: { 'safe/runtime.bin': 'before' }, writes: { 'safe/runtime.bin': 'after' }, observed: ['safe/runtime.bin'] },
  { name: 'E: ignored directory contains forbidden nested file', writes: { 'safe/private/secret.env': 'secret' }, forbidden: ['safe/private/secret.env'], blocked: ['safe/private/secret.env'] },
  { name: 'forbidden ignored deletion', before: { 'secret.env': 'before' }, deletes: ['secret.env'], forbidden: ['secret.env'], blocked: ['secret.env'] },
  { name: 'allowed ignored deletion', before: { 'safe/old.bin': 'before' }, deletes: ['safe/old.bin'], observed: ['safe/old.bin'] },
  { name: 'ignored rename checks the source outside allowed scope', before: { 'cache/old.bin': 'before' }, rename: ['cache/old.bin', 'safe/new.bin'], blocked: ['cache/old.bin'] },
  { name: 'ignored rename inside allowed scope records both paths', before: { 'safe/old.bin': 'before' }, rename: ['safe/old.bin', 'safe/new.bin'], observed: ['safe/old.bin', 'safe/new.bin'] },
  { name: 'ignored Unicode and spaces', writes: { 'safe/中文 space.ignored': 'after' }, observed: ['safe/中文 space.ignored'] },
  { name: 'ignored path beginning with dash', writes: { '-private.ignored': 'secret' }, forbidden: ['-private.ignored'], blocked: ['-private.ignored'] },
  { name: 'content changes even when size and timestamps are restored', before: { 'secret.env': 'before' }, writes: { 'secret.env': 'AFTER!' }, restoreTimes: 'secret.env', forbidden: ['secret.env'], blocked: ['secret.env'] },
];

describe('ignored files obey authoritative scope rules', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    write(repo, '.gitignore', 'secret.env\nsafe/\ncache/\n*.ignored\n');
    git(repo, ['add', '--', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore fixture artifacts']);
    for (const [file, content] of Object.entries(scenario.before ?? {})) write(repo, file, content);
    const baseline = snapshot(repo);
    expect(baseline.clean).toBe(true);
    const task = createTask(opened.store, baseline, { type: 'IMPLEMENTATION', payload: {
      ...implPayload, allowed_scope: ['safe'], forbidden_scope: scenario.forbidden ?? [],
    } });
    const run = await delegateTask(opened.store, baseline, task.id, task.revision, {
      adapterId: 'ignored-scope-fixture', inProcess: true, executionInstanceId: 'ignored-runner',
      adapter: { id: 'ignored-scope-fixture', async probe() {}, async execute() {
        const times = scenario.restoreTimes ? statSync(join(repo, scenario.restoreTimes)) : undefined;
        for (const [file, content] of Object.entries(scenario.writes ?? {})) write(repo, file, content);
        for (const file of scenario.deletes ?? []) unlinkSync(join(repo, file));
        if (scenario.rename) {
          mkdirSync(dirname(join(repo, scenario.rename[1])), { recursive: true });
          renameSync(join(repo, scenario.rename[0]), join(repo, scenario.rename[1]));
        }
        if (times && scenario.restoreTimes) utimesSync(join(repo, scenario.restoreTimes), times.atime, times.mtime);
        return { outcome: 'completed', summary: 'worker claims success', changed_files: [], validation: [], known_limitations: [], exit_code: 0 };
      } },
    });
    if (scenario.blocked) {
      expect(run.status).toBe('blocked');
      expect(run.error_code).toBe('SCOPE_VIOLATION');
      for (const path of scenario.blocked) expect(run.error_detail).toContain(path);
      expect(opened.store.getTask(task.id)?.status).toBe('BLOCKED');
      expect(opened.store.getTask(task.id)?.result).toBeNull();
    } else {
      expect(run.status).toBe('completed');
      const result = opened.store.getTask(task.id)?.result as { changed_files: string[] };
      expect(result.changed_files.sort()).toEqual([...scenario.observed!].sort());
    }
  });

  it('does not attribute its own ignored ledger claim writes to the worker', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    write(repo, '.gitignore', 'ledger.sqlite*\n');
    git(repo, ['add', '--', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore local ledger']);
    const store = Store.open(join(repo, 'ledger.sqlite'), { repoRoot: repo });
    stores.push(store);
    const baseline = snapshot(repo);
    const task = createTask(store, baseline, { type: 'IMPLEMENTATION', payload: implPayload });
    const run = await delegateTask(store, baseline, task.id, task.revision, {
      adapterId: 'ledger-fixture', inProcess: true, executionInstanceId: 'ledger-runner',
      adapter: { id: 'ledger-fixture', async probe() {}, async execute() {
        return { outcome: 'completed', summary: 'no mutation', changed_files: [], validation: [], known_limitations: [], exit_code: 0 };
      } },
    });
    expect(run.status).toBe('completed');
    expect(store.getTask(task.id)?.result).toMatchObject({ changed_files: [] });
  });

  it('does not report a large unchanged ignored cache or trust a claimed filename', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    write(repo, '.gitignore', 'cache/\n');
    git(repo, ['add', '--', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore cache']);
    mkdirSync(join(repo, 'cache'));
    const data = Buffer.alloc(64 * 1024, 42);
    for (let i = 0; i < 256; i++) writeFileSync(join(repo, 'cache', `${i}.bin`), data);
    const baseline = snapshot(repo);
    const task = createTask(opened.store, baseline, { type: 'IMPLEMENTATION', payload: implPayload });
    const run = await delegateTask(opened.store, baseline, task.id, task.revision, {
      adapterId: 'cache-fixture', inProcess: true, executionInstanceId: 'cache-runner',
      adapter: { id: 'cache-fixture', async probe() {}, async execute() {
        return { outcome: 'completed', summary: 'no mutation', changed_files: ['cache/0.bin'], validation: [], known_limitations: [], exit_code: 0 };
      } },
    });
    expect(run.status).toBe('completed');
    expect(opened.store.getTask(task.id)?.result).toMatchObject({ changed_files: [] });
  });
});
