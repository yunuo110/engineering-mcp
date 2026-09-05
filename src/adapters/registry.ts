import { CodexExecAdapter } from './codex-exec-adapter.ts';
import { GenericCliAdapter } from './generic-cli-adapter.ts';
import { loadManifest, type CliAdapterManifest } from './manifest.ts';
import type { WorkerAdapter } from '../orchestration/types.ts';

export interface AdapterFactory {
  id: string;
  create(config: {
    manifestPath?: string;
    manifest?: CliAdapterManifest;
    model?: string;
    profile?: string;
  }): WorkerAdapter;
}

const factories: Record<string, AdapterFactory> = {
  codex: {
    id: 'codex',
    create: () => new CodexExecAdapter(),
  },
  'codex-exec-luna': {
    id: 'codex-exec-luna',
    create: () => new CodexExecAdapter(),
  },
  'generic-cli': {
    id: 'generic-cli',
    create: (config) => {
      const manifest = config.manifest ?? (config.manifestPath ? loadManifest(config.manifestPath) : undefined);
      if (!manifest) throw new Error('generic-cli requires manifest or manifestPath');
      return new GenericCliAdapter(manifest, { model: config.model, profile: config.profile });
    },
  },
};

export function createAdapter(id: string, config: Parameters<AdapterFactory['create']>[0]): WorkerAdapter {
  const factory = factories[id];
  if (!factory) throw new Error(`unknown adapter: ${id}`);
  return factory.create(config);
}
