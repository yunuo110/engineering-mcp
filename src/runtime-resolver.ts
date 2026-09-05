import { fileURLToPath } from 'node:url';

/**
 * Resolve a sibling runtime module from either TypeScript source execution
 * (src/*.ts) or compiled package execution (dist/*.js).
 *
 * Source and dist builds are intentionally explicit so a missing or misnamed
 * entrypoint fails at the file lookup instead of silently falling back to an
 * unrelated file.
 */
export function resolveRuntimeEntry(
  importMetaUrl: string,
  entry: { source: string; dist: string },
): string {
  const currentPath = fileURLToPath(importMetaUrl);
  const relative = currentPath.endsWith('.ts') ? entry.source : entry.dist;
  return fileURLToPath(new URL(relative, importMetaUrl));
}
