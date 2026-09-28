import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const role = process.argv[2] === '--store' ? 'root' : process.argv[2];
const directory = role === 'root'
  ? dirname(process.argv[process.argv.indexOf('--store') + 1])
  : process.argv[3];
if (!['root', 'harness', 'child', 'grandchild'].includes(role) || !directory) process.exit(2);
writeFileSync(join(directory, `${role}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
if (role === 'root' && process.env.ENGINEERING_V2_TEST_BREAKAWAY_EXE) {
  spawn(process.env.ENGINEERING_V2_TEST_BREAKAWAY_EXE, [process.execPath, directory], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
}
const next = { root: 'harness', harness: 'child', child: 'grandchild' }[role];
if (next) spawn(process.execPath, [process.argv[1], next, directory], {
  detached: true, stdio: 'ignore', windowsHide: true,
}).unref();
const deadline = Date.now() + 90_000;
const timer = setInterval(() => {
  if (existsSync(join(directory, `release-${role}`)) || Date.now() > deadline) {
    clearInterval(timer);
    process.exit(0);
  }
}, 100);
