/** Profile-relative package resolution for Electron's restricted Node runtime. */

import { createRequire, registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SEALED_RUNTIME_PACKAGES } from './product-bundles.ts'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

interface PackageManifest {
  name?: unknown
  dependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  exports?: unknown
}

/** One package in the dependency closure shipped beside the Desktop runtime. */
export interface PackagedRuntimePackage {
  name: string
  directory: string
}

/** Read one trusted package manifest from the packaged dependency tree. */
function readPackageManifest(filename: string): PackageManifest {
  return JSON.parse(readFileSync(filename, 'utf8')) as PackageManifest
}

/** Resolve a package root from one App-owned manifest without using profile paths. */
function resolvePackageDirectory(anchor: string, packageName: string): string | undefined {
  let entry: string
  try {
    entry = createRequire(anchor).resolve(packageName)
  } catch {
    // Optional/platform packages can be declared but absent from this build.
    return undefined
  }
  if (!isAbsolute(entry)) return undefined
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readPackageManifest(manifestPath)
      if (manifest.name === packageName) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
  }
}

/**
 * Read the exact package closure reachable from the installed App manifest.
 * Only `@deepseek-ai/*` and explicitly sealed product packages are managed by
 * the product seat; ordinary third-party profile packages remain profile-owned.
 */
export function packagedRuntimePackages(
  installAnchor: string = INSTALL_ANCHOR,
): readonly PackagedRuntimePackage[] {
  const discovered = new Map<string, string>()
  const queue: string[] = [installAnchor]
  while (queue.length > 0) {
    const anchor = queue.shift()
    if (anchor === undefined) break
    const manifest = readPackageManifest(anchor)
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]
    for (const packageName of dependencies) {
      if (discovered.has(packageName)) continue
      const directory = resolvePackageDirectory(anchor, packageName)
      if (directory === undefined) continue
      discovered.set(packageName, directory)
      queue.push(join(directory, 'package.json'))
    }
  }
  const sealed = new Set<string>(SEALED_RUNTIME_PACKAGES)
  return Object.freeze(
    [...discovered.entries()]
      .filter(([packageName]) => packageName.startsWith('@deepseek-ai/') || sealed.has(packageName))
      .map(([name, directory]) => Object.freeze({ name, directory }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  )
}

const PACKAGED_RUNTIME_PACKAGES = packagedRuntimePackages()
const PACKAGED_RUNTIME_PACKAGE_DIRECTORIES = new Map(
  PACKAGED_RUNTIME_PACKAGES.map(({ name, directory }) => [name, directory]),
)
const MANAGED_PACKAGE_NAMES = new Set(PACKAGED_RUNTIME_PACKAGE_DIRECTORIES.keys())

/** Enumerate concrete package exports before installing Node resolution hooks. */
function packageExportSpecifiers(packageName: string, directory: string): readonly string[] {
  const manifest = readPackageManifest(join(directory, 'package.json'))
  const specifiers = new Set<string>([packageName])
  if (typeof manifest.exports === 'object' && manifest.exports !== null) {
    for (const key of Object.keys(manifest.exports)) {
      if (key === '.' || !key.startsWith('./') || key.includes('*')) continue
      specifiers.add(`${packageName}/${key.slice(2)}`)
    }
  }
  return [...specifiers]
}

interface PackagedRuntimeExportPattern {
  readonly packageName: string
  readonly keyPrefix: string
  readonly keySuffix: string
  readonly targetPrefix: string
  readonly targetSuffix: string
  readonly directory: string
}

/** Select the runtime side of one trusted package export condition. */
function runtimeExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const conditions = value as Record<string, unknown>
  return runtimeExportTarget(conditions.default ?? conditions.import ?? conditions.require)
}

/** Compile concrete wildcard export mappings without invoking Node resolution hooks. */
function packageExportPatterns(
  packageName: string,
  directory: string,
): readonly PackagedRuntimeExportPattern[] {
  const manifest = readPackageManifest(join(directory, 'package.json'))
  if (typeof manifest.exports !== 'object' || manifest.exports === null) return []
  const patterns: PackagedRuntimeExportPattern[] = []
  for (const [key, value] of Object.entries(manifest.exports)) {
    const target = runtimeExportTarget(value)
    if (!key.startsWith('./') || !key.includes('*') || target === undefined || !target.includes('*')) continue
    const [keyPrefix, ...keySuffixParts] = key.split('*')
    const [targetPrefix, ...targetSuffixParts] = target.split('*')
    if (keyPrefix === undefined || targetPrefix === undefined) continue
    patterns.push({
      packageName,
      keyPrefix,
      keySuffix: keySuffixParts.join('*'),
      targetPrefix,
      targetSuffix: targetSuffixParts.join('*'),
      directory,
    })
  }
  return patterns
}

const PRODUCT_ENTRY_URLS = new Map<string, string>()
const PRODUCT_EXPORT_PATTERNS: PackagedRuntimeExportPattern[] = []
for (const { name, directory } of [
  ...PACKAGED_RUNTIME_PACKAGES,
  { name: DESKTOP_PACKAGE_NAME, directory: dirname(INSTALL_ANCHOR) },
]) {
  for (const specifier of packageExportSpecifiers(name, directory)) {
    PRODUCT_ENTRY_URLS.set(specifier, import.meta.resolve(specifier))
  }
  PRODUCT_EXPORT_PATTERNS.push(...packageExportPatterns(name, directory))
}

/** Return the App-owned runtime package closure used by profile composition. */
export function packagedRuntimePackageEntries(): readonly PackagedRuntimePackage[] {
  return PACKAGED_RUNTIME_PACKAGES
}

/** Return the packaged directory for one managed runtime package. */
export function packagedRuntimePackageDirectory(packageName: string): string | undefined {
  return PACKAGED_RUNTIME_PACKAGE_DIRECTORIES.get(packageName)
}

/** Extract a package name from a bare package or package-subpath specifier. */
function packageNameOfSpecifier(specifier: string): string | undefined {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0]
}

/** Resolve one App-managed package or subpath to the packaged implementation. */
export function desktopProductEntryUrl(specifier: string): string | undefined {
  const packageName = packageNameOfSpecifier(specifier)
  if (packageName === undefined) return undefined
  if (packageName === DESKTOP_PACKAGE_NAME && specifier === packageName) return DESKTOP_ENTRY_URL
  const productEntry = PRODUCT_ENTRY_URLS.get(specifier)
  if (productEntry !== undefined) return productEntry
  if (!MANAGED_PACKAGE_NAMES.has(packageName) && packageName !== DESKTOP_PACKAGE_NAME) return undefined
  const requestedSubpath = `.${specifier.slice(packageName.length)}`
  for (const pattern of PRODUCT_EXPORT_PATTERNS) {
    if (pattern.packageName !== packageName
      || !requestedSubpath.startsWith(pattern.keyPrefix)
      || !requestedSubpath.endsWith(pattern.keySuffix)) continue
    const captureEnd = requestedSubpath.length - pattern.keySuffix.length
    const capture = requestedSubpath.slice(pattern.keyPrefix.length, captureEnd)
    const target = `${pattern.targetPrefix}${capture}${pattern.targetSuffix}`
    const absolute = resolvePath(pattern.directory, target)
    if (!absolute.startsWith(`${pattern.directory}${sep}`) || !existsSync(absolute)) break
    return pathToFileURL(absolute).href
  }
  const directory = packageName === DESKTOP_PACKAGE_NAME
    ? dirname(INSTALL_ANCHOR)
    : PACKAGED_RUNTIME_PACKAGE_DIRECTORIES.get(packageName)
  const directSubpath = specifier.slice(packageName.length + 1)
  if (directory !== undefined && directSubpath.length > 0) {
    const direct = resolvePath(directory, directSubpath)
    if (direct.startsWith(`${directory}${sep}`) && existsSync(direct)) return pathToFileURL(direct).href
  }
  throw new Error(`Desktop product package export is not sealed: ${specifier}`)
}

/** Return whether a Loader request needs Node package resolution. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/**
 * Resolve Cordis Loader bare imports from the selected persistent profile.
 * @param profileBaseUrl - file URL inside the profile that owns plugin dependencies.
 * @returns an idempotent hook disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === LOADER_ENTRY_URL
      // Product packages are immutable application inputs. Pin an exact
      // product-package request regardless of which Loader helper issued it;
      // Node's parent URL is not guaranteed to be the Loader entrypoint after
      // an include/aggregate plugin delegates the import.
      const productEntry = desktopProductEntryUrl(specifier)
      if (productEntry !== undefined) {
        return { shortCircuit: true, url: productEntry }
      }
      if (!fromLoader || !isBareSpecifier(specifier)) {
        return nextResolve(specifier, context)
      }
      return nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
  }
}
