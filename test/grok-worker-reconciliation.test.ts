import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest, type CliAdapterManifest } from '../src/adapters/manifest.ts';
import {
  buildDurableTargetFromTrustedProfile,
  durableTargetSpecSchema,
} from '../src/c2c/durable-target-registry.ts';
import { createAcceptedDispatchIntentCommandSchema } from '../src/commands/delegation-schema.ts';
import {
  GENERIC_CLI_ARGV_V1,
  GENERIC_CLI_PROMPT_V1,
  GENERIC_CLI_RESULT_V1,
  GENERIC_CLI_TARGET_V1,
} from '../src/commands/generic-cli-target-v1.ts';
import {
  genericCliEwpResultV1Schema,
  parseEngineeringGenericCliResultV1,
} from '../src/commands/generic-cli-ewp-native-v1.ts';
import { SCHEMA_VERSION, WRITER_PROTOCOL_GENERATION } from '../src/types.ts';
import { builtinWorkerProfiles, type WorkerProfiles } from '../src/worker-profiles.ts';

// Offline reconciliation only. These tests never discover or invoke local Grok,
// read a user configuration/credential, open a ledger, or claim a task.
// CLI tokens below come from the official documentation reviewed on 2026-09-19.
// JSON examples are synthetic protocol shapes, NOT captured Grok responses.
function ordinaryManifest(args: string[]): CliAdapterManifest {
  return {
    schema: 'engineering-cli-adapter/1',
    id: 'grok-reconciliation-only',
    name: 'Offline Grok contract candidate',
    adapter: 'generic-cli',
    command: 'grok',
    arguments: args,
    working_directory: '${repo_root}',
    protocol_mode: 'native',
    prompt: { transport: 'stdin', format: 'engineering-worker/1' },
    result: { source: 'stdout', format: 'json', strategy: 'last-json-object' },
    process: { shell: false, success_exit_codes: [0] },
  };
}

function trustedCandidate(
  manifest: CliAdapterManifest,
  overrides: { model?: string; profile?: string } = {},
): WorkerProfiles {
  return {
    defaultProfile: 'grok-reconciliation-only',
    sourcePath: null,
    profiles: new Map([['grok-reconciliation-only', {
      id: 'grok-reconciliation-only',
      adapter: 'generic-cli',
      manifestSnapshot: JSON.stringify(manifest),
      ...overrides,
    }]]),
  };
}

function expectRejectedBeforeDiscovery(
  manifest: CliAdapterManifest,
  overrides: { model?: string; profile?: string } = {},
): void {
  const resolveExecutable = vi.fn(() => {
    throw new Error('Offline reconciliation must not discover an executable');
  });
  const result = buildDurableTargetFromTrustedProfile(
    trustedCandidate(manifest, overrides),
    'grok-reconciliation-only',
    { platform: 'win32', env: {}, resolveExecutable },
  );
  expect(result).toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
  expect(resolveExecutable).not.toHaveBeenCalled();
}

const reportedTerminal = {
  protocol: 'engineering-worker/1',
  outcome: 'completed',
  summary: 'Synthetic reported completion; no model was called',
  changed_files: [],
  validation: [],
  known_limitations: ['Synthetic fixture, not a real Grok invocation'],
  exit_code: 0,
};

describe('Grok Worker invocation reconciliation: offline admission boundaries', () => {
  it('keeps the Grok MCP host example distinct from a registered Worker', () => {
    const host = readFileSync(new URL('../examples/hosts/grok/grok-config.example.toml', import.meta.url), 'utf8');
    expect(host).toContain('[mcp_servers.engineering-mcp]');
    expect(host).toContain('command = "engineering-mcp"');
    expect(host).toContain('args = ["--role", "owner"]');
    const builtin = builtinWorkerProfiles();
    expect(builtin.defaultProfile).toBe('codex-luna');
    expect([...builtin.profiles.keys()]).toEqual(['codex-luna']);
  });

  it('preserves the two frozen target variants and database protocol versions', () => {
    expect(durableTargetSpecSchema.options.map((schema) => schema.shape.schema.value)).toEqual([
      'engineering-launch/1', GENERIC_CLI_TARGET_V1,
    ]);
    expect(GENERIC_CLI_ARGV_V1).toEqual([
      '${repo_root}', '${run_dir}', '${task_id}', '${dispatch_run_id}',
    ]);
    expect(SCHEMA_VERSION).toBe(12);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
  });

  it.each([
    ['headless JSON', ['-p', 'Synthetic prompt', '--output-format', 'json']],
    ['headless plain text', ['-p', 'Synthetic prompt', '--output-format', 'plain']],
    ['ACP stdio', ['agent', 'stdio']],
  ] as const)('does not confuse ordinary manifest validity with durable compatibility: %s', (_name, argv) => {
    const manifest = ordinaryManifest([...argv]);
    expect(validateManifest(manifest)).toEqual({ ok: true, errors: [] });
    expectRejectedBeforeDiscovery(manifest);
  });

  it.each(['-p', '--single', '--output-format', 'json', 'agent', 'stdio', '--no-auto-update'])
    ('rejects even a non-secret literal token in frozen V1: %s', (token) => {
      expectRejectedBeforeDiscovery(ordinaryManifest([token]));
    });

  it('does not enable prompt-wrapper by relabelling an ordinary manifest', () => {
    const manifest = { ...ordinaryManifest([]), protocol_mode: 'prompt-wrapper' as const };
    expect(validateManifest(manifest).ok).toBe(true);
    expectRejectedBeforeDiscovery(manifest);
  });

  it('does not make ordinary JSONL framing part of durable V1', () => {
    const manifest = {
      ...ordinaryManifest([]),
      // Deliberately synthetic event selector: not a claim about Grok output.
      result: { source: 'stdout' as const, format: 'jsonl' as const,
        final_event: { field: 'synthetic_type', equals: 'synthetic_terminal' } },
    };
    expect(validateManifest(manifest).ok).toBe(true);
    expectRejectedBeforeDiscovery(manifest);
  });

  it.each(['profile', 'model'] as const)('never moves an opaque %s value into the durable target', (key) => {
    const sentinel = 'opaque-reconciliation-sentinel';
    const manifest = ordinaryManifest([]);
    const overrides = { [key]: sentinel };
    expectRejectedBeforeDiscovery(manifest, overrides);
    const result = buildDurableTargetFromTrustedProfile(
      trustedCandidate(manifest, overrides), 'grok-reconciliation-only', { platform: 'win32', env: {} },
    );
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    ['ACP prompt completion metadata', { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }],
    ['ACP assistant chunk', { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'synthetic-session', update: { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(reportedTerminal) } },
    } }],
    ['unspecified provider JSON envelope', { type: 'synthetic-result', result: reportedTerminal }],
    ['EWP request echo', { protocol: 'engineering-worker/1', request_id: 'synthetic-request',
      task: { id: 'synthetic-task', type: 'IMPLEMENTATION' }, repository: {}, worker: { role: 'JUNIOR' } }],
  ])('never promotes %s into a strict EWP terminal result', (_name, envelope) => {
    expect(parseEngineeringGenericCliResultV1(JSON.stringify(envelope))).toBeUndefined();
  });

  it('accepts an explicit strict EWP report without treating it as a real invocation proof', () => {
    expect(genericCliEwpResultV1Schema.safeParse(reportedTerminal).success).toBe(true);
    const result = parseEngineeringGenericCliResultV1(JSON.stringify(reportedTerminal));
    expect(result).toMatchObject({ outcome: 'completed', changed_files: [], validation: [] });
    expect(result).not.toHaveProperty('server_authoritative');
    expect(result).not.toHaveProperty('runner_observed');
  });

  it('can describe a future native EWP bridge with the existing target schema only', () => {
    // Schema-only fixture. No executable exists at this path; the zero digest
    // is intentionally synthetic. Artifact verification/E2E are NOT claimed.
    const candidate = {
      schema: GENERIC_CLI_TARGET_V1, platform: 'win32',
      launcher: { kind: 'native-exe', executable_path: 'C:\\synthetic\\engineering-grok-ewp-bridge.exe',
        executable_sha256: '0'.repeat(64) },
      argv_template: [], working_directory_policy: 'task_repo_root',
      prompt_contract: GENERIC_CLI_PROMPT_V1, prompt_transport: 'stdin',
      result_contract: GENERIC_CLI_RESULT_V1, success_exit_codes: [0],
      credential_policy: 'harness-owned-runtime-credentials',
    };
    expect(durableTargetSpecSchema.parse(candidate)).toEqual(candidate);
    expect(durableTargetSpecSchema.safeParse({ ...candidate, grok_executable: 'wire-selected' }).success).toBe(false);
  });

  it('does not add Grok routing or authentication authority to C2C wire commands', () => {
    const command = { command_id: 'synthetic-command', acceptance_command_id: 'synthetic-acceptance',
      worker_profile_id: 'synthetic-profile' };
    expect(createAcceptedDispatchIntentCommandSchema.safeParse(command).success).toBe(true);
    for (const key of ['executable', 'argv', 'environment', 'grok_home', 'profile', 'model', 'credential', 'target_schema']) {
      expect(createAcceptedDispatchIntentCommandSchema.safeParse({ ...command, [key]: 'untrusted' }).success).toBe(false);
    }
  });
});
