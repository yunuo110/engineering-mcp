import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = join(root, 'dist', 'native');
  const names = ['execution-keeper', 'execution-bootstrap', 'execution-worker',
    'authority-git', 'execution-security', 'execution-credential'];
  const attestationPath = join(directory, 'native-build.json');
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET',
    'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) throw new Error('Windows C# compiler required for execution Keeper');
  const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const sourceState = () => ({
    schema: 'engineering-native-build/1',
    scriptSha256: sha256(fileURLToPath(import.meta.url)),
    compilerSha256: sha256(compiler),
    sources: names.map((name) => ({ name, sha256: sha256(join(root, 'src', 'native', `${name}.cs`)) })),
  });
  const verify = () => {
    const recorded = JSON.parse(readFileSync(attestationPath, 'utf8'));
    const current = sourceState();
    if (recorded.schema !== current.schema || recorded.scriptSha256 !== current.scriptSha256
      || recorded.compilerSha256 !== current.compilerSha256
      || !Array.isArray(recorded.sources) || !Array.isArray(recorded.outputs)
      || recorded.sources.length !== names.length || recorded.outputs.length !== names.length) {
      throw new Error('NATIVE_BUILD_REFUSED:build inputs changed');
    }
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (recorded.sources[index].name !== name
        || recorded.sources[index].sha256 !== current.sources[index].sha256
        || recorded.outputs[index].name !== name
        || recorded.outputs[index].sha256 !== sha256(join(directory, `${name}.exe`))) {
        throw new Error(`NATIVE_BUILD_REFUSED:artifact changed: ${name}`);
      }
    }
  };
  if (process.argv.length === 3 && process.argv[2] === '--verify') {
    verify();
  } else if (process.argv.length === 2) {
    mkdirSync(directory, { recursive: true });
    for (const name of names) {
      const source = join(root, 'src', 'native', `${name}.cs`);
      const output = join(directory, `${name}.exe`);
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64',
        '/r:System.Web.Extensions.dll', `/out:${output}`, source], { stdio: 'inherit', windowsHide: true });
    }
    writeFileSync(attestationPath, JSON.stringify({ ...sourceState(),
      outputs: names.map((name) => ({ name, sha256: sha256(join(directory, `${name}.exe`)) })),
    }) + '\n', { encoding: 'utf8' });
    verify();
  } else {
    throw new Error('NATIVE_BUILD_REFUSED:invalid invocation');
  }
}
