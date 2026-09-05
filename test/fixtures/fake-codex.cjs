const fs = require('node:fs');

let outputPath = null;
const idx = process.argv.indexOf('--output-last-message');
if (idx >= 0) outputPath = process.argv[idx + 1];

require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'fake-codex-ran.txt'), 'yes');
const result = {
  outcome: 'completed',
  summary: 'fake codex completed',
  changed_files: [],
  validation: [],
  known_limitations: [],
  exit_code: 0,
};
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(result));
process.exit(0);
