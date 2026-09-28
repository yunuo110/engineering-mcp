export function isPathAllowedByScope(
  path: string,
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
  scopeRules?: ReadonlyArray<{ kind: 'FILE' | 'SUBTREE'; path: string }>,
): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizeScope = (scope: string): string =>
    scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const contains = (scope: string): boolean => {
    const normalizedScope = normalizeScope(scope);
    return (
      normalizedScope === '.' ||
      normalizedPath === normalizedScope ||
      normalizedPath.startsWith(`${normalizedScope}/`)
    );
  };
  if (scopeRules === undefined) {
    return allowedScope.some(contains) && !forbiddenScope.some(contains);
  }
  if (scopeRules.length !== allowedScope.length || scopeRules.some((rule, index) => rule.path !== allowedScope[index])) {
    return false;
  }
  return scopeRules.some((rule) =>
    rule.kind === 'FILE' ? normalizedPath === normalizeScope(rule.path) : contains(rule.path))
    && !forbiddenScope.some(contains);
}
