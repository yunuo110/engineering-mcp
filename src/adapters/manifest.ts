import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';
import YAML from 'yaml';

export const MANIFEST_SCHEMA_ID = 'engineering-cli-adapter/1';
export const ALLOWED_ARGV_VARS = new Set([
  'repo_root',
  'run_dir',
  'task_id',
  'dispatch_run_id',
  'model',
  'profile',
]);

export const cliAdapterManifestSchema = z
  .object({
    schema: z.literal(MANIFEST_SCHEMA_ID),
    id: z.string().min(1),
    name: z.string().min(1),
    adapter: z.literal('generic-cli'),
    command: z.string().min(1),
    arguments: z.array(z.string()),
    working_directory: z.string().min(1),
    prompt: z
      .object({
        transport: z.enum(['stdin', 'file']),
        format: z.literal('engineering-worker/1'),
        argument: z.string().optional(),
      })
      .strict(),
    result: z
      .object({
        source: z.enum(['stdout', 'file']),
        format: z.enum(['json', 'jsonl']),
        strategy: z.enum(['last-json-object']).optional(),
        final_event: z
          .object({
            field: z.string().min(1),
            equals: z.string().min(1),
          })
          .optional(),
        path: z.string().optional(),
      })
      .strict(),
    process: z
      .object({
        shell: z.literal(false),
        success_exit_codes: z.array(z.number().int()),
      })
      .strict(),
    protocol_mode: z.enum(['native', 'prompt-wrapper']).default('native'),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CliAdapterManifest = z.infer<typeof cliAdapterManifestSchema>;

export type ManifestValidation = {
  ok: boolean;
  errors: string[];
};

function validateSafeVariables(value: string): string[] {
  const errors: string[] = [];
  const matches = value.match(/\$\{([^}]+)\}/g) ?? [];
  for (const match of matches) {
    const name = match.slice(2, -1);
    if (!ALLOWED_ARGV_VARS.has(name)) {
      errors.push(`unsafe variable in argv/working directory: ${match}`);
    }
  }
  return errors;
}

export function validateManifest(manifest: unknown): ManifestValidation {
  const parsed = cliAdapterManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }

  const m = parsed.data;
  const errors: string[] = [];

  for (const arg of m.arguments) {
    errors.push(...validateSafeVariables(arg));
  }
  errors.push(...validateSafeVariables(m.working_directory));

  if (m.prompt.transport === 'file' && !m.prompt.argument) {
    errors.push('prompt.file requires argument');
  }
  if (m.result.source === 'file' && !m.result.path) {
    errors.push('result.file requires path');
  }
  if (m.result.source === 'stdout' && m.result.format === 'json' && !m.result.strategy) {
    errors.push('result.stdout json requires strategy: last-json-object');
  }
  if (m.result.source === 'stdout' && m.result.format === 'jsonl' && !m.result.final_event) {
    errors.push('result.stdout jsonl requires final_event');
  }
  if (m.process.shell !== false) {
    errors.push('process.shell must be false');
  }

  return { ok: errors.length === 0, errors };
}

export function loadManifest(path: string): CliAdapterManifest {
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    throw new Error('invalid YAML manifest');
  }
  const validated = cliAdapterManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return validated.data;
}

export function expandTrustedVariables(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (!ALLOWED_ARGV_VARS.has(name) || values[name] === undefined) {
      throw new Error(`unsafe or missing variable: ${match}`);
    }
    return values[name]!;
  });
}
