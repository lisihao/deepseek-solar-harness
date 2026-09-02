/** Source-retained Windows compatibility packages outside the Darwin product. */
export const unsupportedWindowsPackagePaths = new Set([
  'packages/sandbox/sandbox-windows-acl',
  'packages/shell/pwsh-local',
  'packages/shell/pwsh-sandbox',
  'packages/shell/tool-pwsh',
])

/** Whether a repository path belongs to the supported Darwin product package set. */
export function isSupportedDarwinPackagePath(path) {
  const normalized = path.replaceAll('\\', '/')
  const packageRoot = normalized.indexOf('packages/')
  const scopedPath = packageRoot === -1 ? normalized : normalized.slice(packageRoot)
  return ![...unsupportedWindowsPackagePaths].some(packagePath => (
    scopedPath === packagePath || scopedPath.startsWith(`${packagePath}/`)
  ))
}
