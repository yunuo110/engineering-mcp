const fs = require('node:fs');
const path = require('node:path');
const idx = process.argv.indexOf('--prompt-file');
if (idx < 0) process.exit(2);
const promptFile = process.argv[idx + 1];
const resultPath = path.join(path.dirname(promptFile), 'result.json');
fs.writeFileSync(resultPath, JSON.stringify({
  protocol: 'engineering-worker/1',
  outcome: 'blocked',
  summary: 'file blocked',
  changed_files: [],
  validation: [],
  known_limitations: [],
  blocked_reason: 'required dependency unavailable',
  exit_code: 1,
}));
