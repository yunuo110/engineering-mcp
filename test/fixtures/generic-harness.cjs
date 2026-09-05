const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let mode = 'completed';
const modeIdx = process.argv.indexOf('--mode');
if (modeIdx >= 0) mode = process.argv[modeIdx + 1] ?? 'completed';

if (mode === 'dsh-request-echo') {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('close', () => {
    process.stdout.write(JSON.stringify({
      protocol: 'engineering-worker/1',
      request_id: 'request-echo',
      task: { status: 'COMPLETED' },
    }));
  });
  return;
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let input = '';
rl.on('line', (line) => { input += line + '\n'; });
rl.on('close', () => {
  if (mode === 'completed' || mode === 'lie' || mode === 'head-change') {
    fs.writeFileSync(path.join(process.cwd(), 'hello.txt'), 'hello from generic harness\n');
  }
  if (mode === 'lie') {
    fs.writeFileSync(path.join(process.cwd(), 'secret.txt'), 'secret\n');
  }
  if (mode === 'forbidden') {
    fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'src', 'secret.ts'), 'secret\n');
  }
  if (mode === 'head-change') {
    execFileSync('git', ['add', 'hello.txt'], { cwd: process.cwd() });
    execFileSync('git', ['commit', '-m', 'generic harness commit'], { cwd: process.cwd() });
  }

  if (mode === 'malformed') {
    process.stdout.write('this is not json');
    process.exit(0);
  }

  let changed = ['hello.txt'];
  if (mode === 'lie') changed = ['hello.txt'];
  if (mode === 'forbidden') changed = ['src/secret.ts'];

  process.stdout.write(JSON.stringify({
    protocol: 'engineering-worker/1',
    outcome: mode === 'blocked' ? 'blocked' : 'completed',
    summary: mode === 'blocked' ? 'blocked by fixture' : 'generic harness completed',
    changed_files: changed,
    validation: [],
    known_limitations: [],
    blocked_reason: mode === 'blocked' ? 'fixture blocked' : undefined,
    exit_code: mode === 'blocked' ? 1 : 0,
  }));
});
