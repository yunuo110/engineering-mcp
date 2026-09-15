export function isPathAllowedByScope(
  path: string,
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const contains = (scope: string): boolean => {
    const normalizedScope = scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return (
      normalizedScope === '.' ||
      normalizedPath === normalizedScope ||
      normalizedPath.startsWith(`${normalizedScope}/`)
    );
  };
  return allowedScope.some(contains) && !forbiddenScope.some(contains);
}
