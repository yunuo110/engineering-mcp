const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let input = '';
rl.on('line', (line) => { input += line + '\n'; });
rl.on('close', () => {
  process.stdout.write('{"type":"meta","count":1}\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    protocol: 'engineering-worker/1',
    outcome: 'completed',
    summary: 'jsonl completed',
    changed_files: [],
    validation: [],
    known_limitations: [],
    exit_code: 0,
  }) + '\n');
});
