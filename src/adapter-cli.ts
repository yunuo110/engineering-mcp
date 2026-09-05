import { execFileSync } from 'node:child_process';
import { loadManifest, validateManifest } from './adapters/manifest.ts';

function main(): void {
  const [cmd, sub, manifestPath] = process.argv.slice(2);
  if (cmd !== 'adapter') {
    throw new Error('usage: engineering-mcp adapter validate|probe|smoke <manifest>');
  }
  if (!manifestPath) throw new Error('missing manifest path');
  const manifest = loadManifest(manifestPath);
  const validation = validateManifest(manifest);
  if (sub === 'validate') {
    console.log(JSON.stringify({ ok: validation.ok, errors: validation.errors }, null, 2));
    process.exit(validation.ok ? 0 : 1);
    return;
  }
  if (sub === 'probe') {
    let version: string | null = null;
    try {
      version = execFileSync(manifest.command, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    } catch {
      version = null;
    }
    console.log(JSON.stringify({
      ok: validation.ok && version !== null,
      validation,
      command: manifest.command,
      version,
      authenticated_model_execution: 'not tested',
    }, null, 2));
    process.exit(validation.ok && version !== null ? 0 : 1);
    return;
  }
  if (sub === 'smoke') {
    throw new Error('adapter smoke is opt-in and requires a configured real harness; not run from this command');
  }
  throw new Error(`unknown adapter subcommand: ${sub}`);
}

main();
