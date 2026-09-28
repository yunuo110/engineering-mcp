import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const acceptedEntries = [
  join(root, 'dist', 'cli.js'),
  // CLI's runServer() starts this file with process.execPath; it is a runtime
  // edge, not a static import edge.
  join(root, 'dist', 'index.js'),
  join(root, 'dist', 'orchestration', 'c2c-worker-runner-entry.js'),
  join(root, 'dist', 'orchestration', 'worker-runner-entry.js'),
  // Native process edges are just as authority-bearing as module imports.
  join(root, 'dist', 'native', 'execution-bootstrap.exe'),
  join(root, 'dist', 'native', 'execution-keeper.exe'),
  join(root, 'dist', 'native', 'execution-worker.exe'),
  join(root, 'dist', 'native', 'authority-git.exe'),
  join(root, 'dist', 'native', 'execution-security.exe'),
];
const allowedPackages = new Set(['@modelcontextprotocol/server', '@modelcontextprotocol/core',
  'zod', 'smol-toml', 'yaml']);
const reached = new Set();
const packages = new Set();
const nonliteral = [];

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
function selectExport(value, mode) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of [mode, 'node', 'default']) {
    if (Object.hasOwn(value, key)) {
      const selected = selectExport(value[key], mode);
      if (selected) return selected;
    }
  }
  return undefined;
}
function exactFile(base) {
  for (const path of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`,
    `${base}.node`, join(base, 'index.js'), join(base, 'index.cjs'), join(base, 'index.mjs')]) {
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`unresolved runtime module: ${base}`);
}
function packageRoot(name) {
  const path = join(root, 'node_modules', ...name.split('/'));
  if (!allowedPackages.has(name) || !existsSync(join(path, 'package.json')))
    throw new Error(`unapproved runtime package: ${name}`);
  packages.add(realpathSync(join(path, 'package.json')));
  return path;
}
function resolveSpecifier(from, specifier, mode) {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('#') || isAbsolute(specifier))
    throw new Error(`unsupported runtime specifier: ${specifier} in ${from}`);
  if (specifier.startsWith('.')) return exactFile(resolve(dirname(from), specifier));
  const name = packageName(specifier);
  const path = packageRoot(name);
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
  let target;
  if (pkg.exports) {
    const exported = pkg.exports[subpath] ?? (subpath === '.' && !Object.hasOwn(pkg.exports, '.')
      ? pkg.exports : undefined);
    target = selectExport(exported, mode);
  } else if (subpath === '.') {
    target = pkg.main ?? './index.js';
  } else target = subpath;
  if (!target || !target.startsWith('./'))
    throw new Error(`unresolved package export: ${specifier} from ${from}`);
  const resolved = exactFile(resolve(path, target));
  const part = relative(path, resolved);
  if (part.startsWith('..') || isAbsolute(part))
    throw new Error(`package escape: ${specifier}`);
  return resolved;
}
function scan(path) {
  if (reached.has(path)) return;
  reached.add(path);
  const extension = extname(path);
  if (!['.js', '.cjs', '.mjs'].includes(extension)) return;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true,
    ts.ScriptKind.JS);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(path, node.moduleSpecifier.text, 'import');
      if (target) scan(target);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const callMode = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require';
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const target = resolveSpecifier(path, node.arguments[0].text, callMode);
        if (target) scan(target);
      } else nonliteral.push({ path, expression: node.getText(source).slice(0, 160) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const entry of acceptedEntries) scan(realpathSync(entry));
for (const path of packages) reached.add(path);
reached.add(realpathSync(join(root, 'package.json')));
const paths = [...reached].sort((a, b) => a.localeCompare(b));
const yamlCli = join(root, 'node_modules', 'yaml', 'dist', 'cli.mjs');
const report = {
  schema: 'engineering-v2-trusted-closure/1',
  sourceRoot: root,
  entries: acceptedEntries,
  paths,
  nonliteral,
  yamlCliDisposition: reached.has(yamlCli)
    ? 'REACHABLE' : 'NOT_IN_ACCEPTED_RUNTIME_CLOSURE',
};
console.log(JSON.stringify(report));
if (nonliteral.length || report.yamlCliDisposition !== 'NOT_IN_ACCEPTED_RUNTIME_CLOSURE')
  process.exitCode = 2;
