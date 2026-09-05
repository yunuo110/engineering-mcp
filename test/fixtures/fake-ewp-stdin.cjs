const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let input = '';
rl.on('line', (line) => { input += line + '\n'; });
rl.on('close', () => {
  process.stdout.write(JSON.stringify({
    protocol: 'engineering-worker/1',
    outcome: 'completed',
    summary: 'fake completed',
    changed_files: ['src/example.ts'],
    validation: [{ command: 'npm test', status: 'passed', summary: 'ok' }],
    known_limitations: [],
    exit_code: 0,
  }));
});
