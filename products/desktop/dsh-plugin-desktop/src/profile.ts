/** Compatibility profile composition over the official Web bundle and user plugins. */

import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  composeEntries,
  initProfile,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import FileSettingsProvider, {
  resolveSpec as resolveSettingsFileSpec,
  type Config as SettingsFileConfig,
} from '@deepseek-ai/dsh-settings-file'
import { parseDocument } from 'yaml'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import {
  packagedRuntimePackageDirectory,
  packagedRuntimePackageEntries,
} from './module-resolution.ts'
import {
  AGENT_TEAMS_PACKAGE,
  AGENT_TEAMS_ROW_ID,
  PRODUCT_BUNDLE_PACKAGES,
  PRODUCT_BUNDLE_ROW_IDS,
  PLUGIN_CONSOLE_PACKAGE,
  PLUGIN_CONSOLE_ROW_ID,
  UI_REMOTE_MODULES_PACKAGE,
  UI_REMOTE_MODULES_ROW_ID,
} from './product-bundles.ts'
import type { DesktopShellMode } from './runtime.ts'

/** Persistent profile managed by the desktop launcher and the ordinary dsh plugin command. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Persistent profile owned by the headless product server launcher. */
export const PRODUCT_SERVER_PROFILE_NAME = 'product-server'

/** Standalone package name inserted through the launcher-owned desktop layer. */
export const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Empty include root rewritten before every product-profile boot. */
export const PRODUCT_PROFILE_ROOT = 'cordis.yml'

/** Existing Desktop-facing name retained for package compatibility. */
export const DESKTOP_PROFILE_ROOT = PRODUCT_PROFILE_ROOT

const BIN_NAME = DESKTOP_PACKAGE_NAME
const REQUIRED_BUNDLES = requiredWebBundles()
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const INSTALL_ANCHOR = unpackedAsarPath(fileURLToPath(new URL('../package.json', import.meta.url)))
const DESKTOP_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const SERVER_BROWSE_PICKER_HOST_ROW_ID = 'product-server-directory-picker-browse-host'
const SERVER_BROWSE_PICKER_SURFACE_ROW_ID = 'product-server-directory-picker-browse-surface'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = 'dsh-plugin-desktop/windows-pwsh-sandbox'
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'compatibility'
const PRODUCT_MODULE_BASE_DIR = '.dsh-product-runtime'
const SETTINGS_FILE_PACKAGE = '@deepseek-ai/dsh-settings-file'
const AGENT_DEFAULT_MODEL_PACKAGE = '@deepseek-ai/dsh-agent-default-model'
const PRODUCT_DEFAULT_AGENT_MODEL = Object.freeze({
  provider: 'dsh-physical-operator',
  model: 'codex',
})
const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'
const UI_LAYOUT_PACKAGE = '@deepseek-ai/dsh-client-ui-layout'
const UI_SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
const UI_CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const RESIDENT_OPERATOR_STARTUP_TIMEOUT_MS = 15_000
const RETIRED_PRODUCT_BUNDLES = new Set([
  '@liustack/modlens',
  '@ycp424c/dsh-luna-vision-bridge',
  'dsh-memory-evolve',
])
const RETIRED_PRODUCT_ROWS = ['modlens', 'luna-vision-bridge', 'dsh-memory-evolve'] as const
/**
 * Parse desktop presentation state and reject corrupted values.
 * @param value - untrusted settings value.
 * @returns a supported desktop shell mode.
 */
export function parseDesktopShellMode(value: unknown): DesktopShellMode {
  if (value === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (value === 'compatibility' || value === 'advanced') return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.mode must be "compatibility" or "advanced"`)
}

/**
 * Read a desktop mode from one parsed settings document.
 * @param document - untrusted settings document root.
 * @returns the selected mode, defaulting to compatibility when absent.
 */
export function desktopShellModeFromSettings(document: unknown): DesktopShellMode {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${BIN_NAME}: settings document must be a map of namespace sections`)
  }
  const section = (document as Record<string, unknown>)[DESKTOP_SETTINGS_NAMESPACE]
  if (section === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  return parseDesktopShellMode((section as Record<string, unknown>).mode)
}

/**
 * Read startup mode from the same file resolved by the settings provider.
 * @param config - validated settings-file row config.
 * @returns the mode projected into the startup Loader graph.
 */
export function readDesktopShellMode(config: SettingsFileConfig): DesktopShellMode {
  const spec = resolveSettingsFileSpec(config)
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_DESKTOP_SHELL_MODE
    throw cause
  }
  let document: unknown
  if (spec.format === 'yaml') {
    const parsed = parseDocument(text, { prettyErrors: true })
    if (parsed.errors.length > 0) {
      throw new Error(`${BIN_NAME}: invalid settings document at ${spec.filename}: ${parsed.errors.map(error => error.message).join('; ')}`)
    }
    document = parsed.toJS() ?? {}
  } else {
    document = text.trim().length === 0 ? {} : JSON.parse(text)
  }
  return desktopShellModeFromSettings(document)
}

/** Resolve the public Web template once and reject an incompatible DSH release. */
function requiredWebBundles(): string[] {
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return [...bundles]
}

/** Shared product-profile inputs consumed by app-boot. */
export interface PreparedProductProfile {
  /** Harness home shared by the launcher and generated command environment. */
  homeDir: string
  /** Resolved profile and its persistent user layer. */
  profile: Profile
  /** Absolute empty root config included by the Cordis Loader. */
  rootConfig: string
  /** Profile-owned parent URL used to resolve bare Cordis plugin packages. */
  bareModuleBaseUrl: string
  /** Complete ordered patch list for this product generation. */
  patches: PatchOptions[]
  /** Persisted presentation mode applied to browser rows and, on Desktop, the native shell. */
  mode: DesktopShellMode
}

/** Product composition consumed by the Electron launcher. */
export type PreparedDesktopProfile = PreparedProductProfile

/** Product composition consumed by the headless server launcher. */
export type PreparedProductServerProfile = PreparedProductProfile

/**
 * Normalize the installation-owned prefix, retire removed product bundles,
 * and preserve the remaining third-party order.
 * @param current - current persistent bundle list.
 * @returns base, Web carrier, then every third-party bundle in prior order.
 */
export function productBundleList(current: readonly string[]): string[] {
  const thirdParty = current.filter(name => (
    !REQUIRED_BUNDLE_SET.has(name)
    && name !== DESKTOP_PACKAGE_NAME
    && !RETIRED_PRODUCT_BUNDLES.has(name)
  ))
  return [...REQUIRED_BUNDLES, ...thirdParty]
}

/** Existing Desktop-facing name retained for package compatibility. */
export const desktopBundleList = productBundleList

/** Return whether two ordered string lists are identical. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Initialize or repair one persistent product profile.
 * @param profileName - profile identity owned by a product Host adapter.
 * @param home - Harness home containing the profiles directory.
 * @returns the absolute profile directory.
 */
function ensureProductProfile(profileName: string, home: string): string {
  const dir = resolveProfileDir(profileName, home)
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, REQUIRED_BUNDLES)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const current = rawBundles === undefined ? [] : rawBundles as string[]
  const bundles = productBundleList(current)
  if (!sameList(current, bundles)) {
    writeProfileManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    })
  }
  return dir
}

export function ensureDesktopProfile(home: string = resolveDshHome()): string {
  return ensureProductProfile(DESKTOP_PROFILE_NAME, home)
}

/** Initialize or repair the persistent headless product-server profile. */
export function ensureProductServerProfile(home: string = resolveDshHome()): string {
  return ensureProductProfile(PRODUCT_SERVER_PROFILE_NAME, home)
}

/** Resolve the agent presets shipped by the matching dsh CLI dependency. */
function shippedPresetRoot(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
}

/** Resolve the Desktop-owned preset root from source or the unpacked application. */
function productPresetRoot(): string {
  return unpackedAsarPath(fileURLToPath(new URL('../vendor/agent-presets', import.meta.url)))
}

/** Resolve the bundle patch declared by one sealed product package. */
function productBundlePatchPath(require: NodeJS.Require, packageName: string): string {
  const packagePath = require.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    dsh?: { bundle?: { patch?: unknown } }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    throw new Error(`${BIN_NAME}: sealed product bundle ${packageName} does not declare dsh.bundle.patch`)
  }
  return join(dirname(packagePath), patch)
}

/** Load product-owned bundles from the packaged application dependency tree. */
function productBundlePatches(
  installedPackages: ReadonlySet<string>,
  suppliedRows: ReadonlySet<string>,
): PatchOptions[] {
  const require = createRequire(import.meta.url)
  return PRODUCT_BUNDLE_PACKAGES
    .filter(packageName => (
      !installedPackages.has(packageName)
      && !suppliedRows.has(PRODUCT_BUNDLE_ROW_IDS.get(packageName) ?? '')
    ))
    .flatMap(packageName => loadOverlayPatches(
      BIN_NAME,
      productBundlePatchPath(require, packageName),
    ))
}

/** Bind legacy plugin-console rows to the product-sealed package in memory. */
export function bindPluginConsolePatches(patches: readonly PatchOptions[]): PatchOptions[] {
  return patches.map((patch) => {
    if (patch.insert !== undefined) {
      return {
        ...patch,
        insert: patch.insert.map((row) => row.id === PLUGIN_CONSOLE_ROW_ID
          ? { ...row, name: PLUGIN_CONSOLE_PACKAGE }
          : row),
      }
    }
    return patch.id === PLUGIN_CONSOLE_ROW_ID && patch.name !== undefined
      ? { ...patch, name: PLUGIN_CONSOLE_PACKAGE }
      : patch
  })
}

/** Ensure one runtime-owned package link, rejecting an unrelated real path. */
function ensureRuntimePackageLink(link: string, target: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(link)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: generated product package link is occupied by a real path: ${link}`)
    }
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  symlinkSync(target, link, 'junction')
}

/** Remove only stale links previously generated inside the App-owned seat. */
function pruneRuntimePackageLinks(modules: string, expected: ReadonlySet<string>): void {
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const entryPath = join(modules, entry.name)
    if (entry.isSymbolicLink()) {
      if (!expected.has(entryPath)) unlinkSync(entryPath)
      continue
    }
    if (!entry.isDirectory()) continue
    // Package scopes are the only nested directories generated by this seat.
    for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
      const scopedPath = join(entryPath, scopedEntry.name)
      if (scopedEntry.isSymbolicLink() && !expected.has(scopedPath)) unlinkSync(scopedPath)
    }
    if (readdirSync(entryPath).length === 0) rmdirSync(entryPath)
  }
}

/**
 * Build the profile-local resolution seat from the exact App dependency
 * closure. Product packages resolve from this generated seat first; ordinary
 * packages continue through the selected profile's own node_modules.
 */
function ensureProductModuleBase(profileDir: string, includeDesktopAdapter: boolean): string {
  const root = join(profileDir, PRODUCT_MODULE_BASE_DIR)
  const modules = join(root, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const packagePath = join(root, 'package.json')
  writeFileSync(packagePath, '{"name":"dsh-product-runtime-base","private":true}\n')
  const packages = includeDesktopAdapter
    ? [DESKTOP_PACKAGE_NAME, ...packagedRuntimePackageEntries().map(({ name }) => name)]
    : packagedRuntimePackageEntries().map(({ name }) => name)
  const expectedLinks = new Set(packages.map(packageName => join(modules, packageName)))
  for (const packageName of packages) {
    const target = packageName === DESKTOP_PACKAGE_NAME
      ? dirname(INSTALL_ANCHOR)
      : packagedRuntimePackageDirectory(packageName)
    if (target === undefined) {
      throw new Error(`${BIN_NAME}: packaged runtime package is missing from the App dependency closure: ${packageName}`)
    }
    const link = join(modules, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureRuntimePackageLink(link, target)
  }
  pruneRuntimePackageLinks(modules, expectedLinks)
  return packagePath
}

/** Read a row's object config without trusting arbitrary YAML values. */
function rowConfig(row: EntryOptions | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** Resolve a Loader row's platform gate without mutating the host process. */
function rowDisabledOnPlatform(row: EntryOptions, platform: NodeJS.Platform): boolean {
  if (!isJsExpr(row.disabled)) return row.disabled === true
  const scopedProcess = new Proxy(process, {
    get(target, property) {
      if (property === 'platform') return platform
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Boolean(evaluate({ process: scopedProcess }, row.disabled.__jsExpr))
}

type ProductHostAdapter = 'desktop' | 'server'

interface ProductProfileOptions {
  telemetryDisabled: string | undefined
  home: string
  platform: NodeJS.Platform
  profileName: string
  adapter: ProductHostAdapter
}

const DESKTOP_ADAPTER_ROW_IDS = [
  'desktop-shell',
  'desktop-terminal',
  'desktop-pnpm',
  'desktop-profiles',
  'desktop-updates',
  'desktop-directory-picker-browse-host',
  'desktop-directory-picker-browse-surface',
  DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID,
] as const

/** Build the shared product composition, then add exactly one Host adapter. */
function prepareProductProfile(options: ProductProfileOptions): PreparedProductProfile {
  const { telemetryDisabled, home, platform, profileName, adapter } = options
  if (profileName === DESKTOP_PROFILE_NAME) ensureDesktopProfile(home)
  else if (profileName === PRODUCT_SERVER_PROFILE_NAME) ensureProductServerProfile(home)
  else resolveProfileDir(profileName, home)
  const profile = loadProfile(BIN_NAME, profileName, INSTALL_ANCHOR, home)
  const moduleBasePath = ensureProductModuleBase(profile.dir, adapter === 'desktop')
  // app-boot derives ctx.baseUrl (used by clientModules) from the root config
  // directory. Keep the empty generated root beside the product-first module
  // seat so Host imports and browser client bundles resolve the same package.
  const rootConfig = join(dirname(moduleBasePath), PRODUCT_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(moduleBasePath).href
  writeFileSync(rootConfig, '[]\n')

  const adapterPatches = adapter === 'desktop'
    ? loadOverlayPatches(BIN_NAME, DESKTOP_PATCH_PATH)
    : []
  const homePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const selectedProfilePatches = bindPluginConsolePatches([
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...homePatches,
  ])
  const suppliedRows = new Set(
    composeEntries([selectedProfilePatches])
      .flatMap(row => typeof row.id === 'string' ? [row.id] : []),
  )
  const productPatches = productBundlePatches(
    new Set(profile.layers.map(layer => layer.packageName)),
    suppliedRows,
  )
  const bundlePatches: PatchOptions[] = []
  let productLayerInserted = false
  for (const layer of profile.layers) {
    bundlePatches.push(...layer.patches)
    if (layer.packageName !== '@deepseek-ai/dsh-web-app') continue
    bundlePatches.push(...adapterPatches)
    bundlePatches.push(...productPatches)
    productLayerInserted = true
  }
  if (!productLayerInserted) {
    throw new Error(`${BIN_NAME}: product profile is missing @deepseek-ai/dsh-web-app`)
  }

  const patches: PatchOptions[] = bindPluginConsolePatches([
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
  ])
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([patches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  for (const id of RETIRED_PRODUCT_ROWS) {
    if (rows.has(id)) patches.push({ id, disabled: true })
  }
  const settings = rows.get('settings')
  if (settings?.name !== SETTINGS_FILE_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_FILE_PACKAGE} in the settings row`)
  }
  const residentOperators = rows.get('resident-operators')
  if (residentOperators?.name !== '@deepseek-ai/dsh-resident-operator-local') {
    throw new Error(`${BIN_NAME}: desktop profile must provide the Resident operator row`)
  }
  patches.push({
    id: 'resident-operators',
    config: {
      ...rowConfig(residentOperators),
      connectTimeoutMs: RESIDENT_OPERATOR_STARTUP_TIMEOUT_MS,
    },
  })
  const settingsConfig = FileSettingsProvider.Config({
    dshHome: home,
    ...rowConfig(settings),
  } as SettingsFileConfig)
  // Product Server owns the remote Host graph, not an Electron renderer. Its
  // browser shell must retain the compatibility layout even when a Desktop
  // Frontend has selected the native advanced presentation in its own state.
  // Applying the Desktop-only setting here disables ui-layout without loading
  // dsh-plugin-desktop/client, leaving every layout consumer pending.
  const mode = adapter === 'desktop'
    ? readDesktopShellMode(settingsConfig)
    : DEFAULT_DESKTOP_SHELL_MODE
  patches.push({
    id: 'settings',
    config: settingsConfig,
  })
  const agentDefaultModel = rows.get('agent-default-model')
  if (agentDefaultModel?.name !== AGENT_DEFAULT_MODEL_PACKAGE) {
    throw new Error(`${BIN_NAME}: product profile must use ${AGENT_DEFAULT_MODEL_PACKAGE} in the agent-default-model row`)
  }
  // Product composition prefers the native Codex physical operator for a
  // clean install.  AgentDefaultModelConfig layers the user's persisted
  // `agent-default-model` settings section over this value at runtime, so an
  // existing explicit selection remains authoritative.
  patches.push({
    id: 'agent-default-model',
    config: {
      ...rowConfig(agentDefaultModel),
      ...PRODUCT_DEFAULT_AGENT_MODEL,
    },
  })
  if (mode === 'advanced') {
    for (const [id, packageName] of [
      ['ui-layout', UI_LAYOUT_PACKAGE],
      ['ui-sidebar', UI_SIDEBAR_PACKAGE],
      ['ui-conversation', UI_CONVERSATION_PACKAGE],
    ] as const) {
      if (rows.get(id)?.name !== packageName) {
        throw new Error(`${BIN_NAME}: advanced desktop mode must use ${packageName} in the ${id} row`)
      }
    }
    patches.push(
      { id: 'ui-layout', disabled: true },
      { id: 'ui-sidebar', disabled: false },
      { id: 'ui-conversation', disabled: false },
    )
  }
  const presets = rows.get('agent-presets')
  if (presets !== undefined) {
    patches.push({
      id: 'agent-presets',
      config: {
        ...rowConfig(presets),
        roots: [
          { path: productPresetRoot(), trust: 'system' },
          { path: shippedPresetRoot(), trust: 'system' },
        ],
      },
    })
  }
  const agentTeams = rows.get(AGENT_TEAMS_ROW_ID)
  if (agentTeams?.name !== AGENT_TEAMS_PACKAGE) {
    throw new Error(`${BIN_NAME}: product profile must use ${AGENT_TEAMS_PACKAGE} in the ${AGENT_TEAMS_ROW_ID} row`)
  }
  patches.push({
    id: AGENT_TEAMS_ROW_ID,
    config: {
      ...rowConfig(agentTeams),
      memberPersonaPlacement: 'prompt',
    },
  })
  // The plugin console is product-owned. A selected legacy Web profile may
  // still contribute the former @dsh-external row after the Desktop overlay;
  // this final binding keeps the row on the sealed, non-blocking package.
  patches.push({
    id: PLUGIN_CONSOLE_ROW_ID,
    name: PLUGIN_CONSOLE_PACKAGE,
    disabled: false,
  })
  // Remote Web pages are user-owned profile data. The public Desktop ships the
  // configuration surface but never embeds one operator's private targets.
  const remoteModules = rows.get(UI_REMOTE_MODULES_ROW_ID)
  const remoteModuleConfig = rowConfig(remoteModules)
  const configuredInstances = remoteModuleConfig.instances
  patches.push({
    id: UI_REMOTE_MODULES_ROW_ID,
    name: UI_REMOTE_MODULES_PACKAGE,
    disabled: false,
    config: {
      ...remoteModuleConfig,
      instances: Array.isArray(configuredInstances) ? configuredInstances : [],
    },
  })
  if (adapter === 'server') {
    // The Web bundle's connection row is declared before the optional product
    // bundles.  Remote Sync captures these seams during its API-proxy
    // injection, so the Server must wait for both authorities instead of
    // permanently capturing an undefined optional service.
    patches.push({
      id: 'connection',
      inject: ['webRuntime', 'webStartup', 'residentOperators', 'orchestrations', 'remoteOperatorHost'],
    })
  }
  if (!rows.has('webserver')) {
    throw new Error(`${BIN_NAME}: desktop profile has no webserver row`)
  }
  if (adapter === 'desktop' && platform === 'win32') {
    if (!rows.has(DIRECTORY_PICKER_ROW_ID)) {
      throw new Error(`${BIN_NAME}: desktop profile has no directory-picker row`)
    }
    patches.push(
      {
        id: DIRECTORY_PICKER_ROW_ID,
        name: AUTO_PICKER_PACKAGE,
        disabled: true,
      },
      {
        insert: [
          {
            id: 'desktop-directory-picker-browse-host',
            name: BROWSE_PICKER_BACKEND,
          },
          {
            id: 'desktop-directory-picker-browse-surface',
            name: BROWSE_PICKER_SURFACE,
          },
        ],
      },
    )
    const pwshSandbox = rows.get(PWSH_SANDBOX_ROW_ID)
    if (pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE
      && !rowDisabledOnPlatform(pwshSandbox, platform)) {
      patches.push(
        {
          id: PWSH_SANDBOX_ROW_ID,
          name: UPSTREAM_PWSH_SANDBOX_PACKAGE,
          disabled: true,
        },
        {
          insert: [
            {
              id: DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID,
              name: DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE,
              ...(pwshSandbox.disabled === undefined ? {} : { disabled: pwshSandbox.disabled }),
              config: rowConfig(pwshSandbox),
            },
          ],
        },
      )
    }
  }
  if (adapter === 'desktop') {
    // Loopback-only binding is a launcher security invariant, not user config.
    patches.push({
      id: 'webserver',
      disabled: false,
      config: { host: '127.0.0.1', port: 0 },
    })
  } else {
    if (!rows.has(DIRECTORY_PICKER_ROW_ID)) {
      throw new Error(`${BIN_NAME}: product server profile has no directory-picker row`)
    }
    patches.push(
      {
        id: DIRECTORY_PICKER_ROW_ID,
        name: AUTO_PICKER_PACKAGE,
        disabled: true,
      },
      {
        insert: [
          { id: SERVER_BROWSE_PICKER_HOST_ROW_ID, name: BROWSE_PICKER_BACKEND },
          { id: SERVER_BROWSE_PICKER_SURFACE_ROW_ID, name: BROWSE_PICKER_SURFACE },
        ],
      },
    )
    // Host/port/trust remain command-line values supplied by product-server.
    patches.push({ id: 'webserver', disabled: false })
  }
  if ((telemetryDisabled ?? '') !== '' && rows.has('session-telemetry-otel')) {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }
  if (adapter === 'desktop') {
    const desktopShell = rows.get('desktop-shell')
    if (desktopShell === undefined) {
      throw new Error(`${BIN_NAME}: desktop profile has no desktop-shell row`)
    }
    patches.push({
      id: 'desktop-shell',
      disabled: false,
      config: {
        ...rowConfig(desktopShell),
        mode,
      },
    })
  } else {
    const composedRows = composeEntries([patches])
    const desktopRows = composedRows
      .filter(row => typeof row.id === 'string' && DESKTOP_ADAPTER_ROW_IDS.includes(row.id as typeof DESKTOP_ADAPTER_ROW_IDS[number]))
      .map(row => row.id)
    if (desktopRows.length > 0) {
      throw new Error(`${BIN_NAME}: product server profile contains Desktop-only rows: ${desktopRows.join(', ')}`)
    }
  }
  return {
    homeDir: home,
    profile,
    rootConfig,
    bareModuleBaseUrl,
    patches: structuredClone(patches),
    mode,
  }
}

/**
 * Load and compose one desktop profile generation.
 * @param telemetryDisabled - inherited DSH telemetry opt-out value.
 * @param home - Harness home containing profiles and the machine-wide patch.
 * @param platform - native platform selecting launcher-owned safety overlays.
 * @param profileName - existing or lazily available Web profile to compose.
 * @returns root config, profile metadata, and ordered patches.
 */
export function prepareDesktopProfile(
  telemetryDisabled: string | undefined = process.env.DSH_TELEMETRY_DISABLED,
  home: string = resolveDshHome(),
  platform: NodeJS.Platform = process.platform,
  profileName: string = DESKTOP_PROFILE_NAME,
): PreparedDesktopProfile {
  return prepareProductProfile({ telemetryDisabled, home, platform, profileName, adapter: 'desktop' })
}

/** Load the same sealed product composition without Electron-owned rows. */
export function prepareProductServerProfile(
  telemetryDisabled: string | undefined = process.env.DSH_TELEMETRY_DISABLED,
  home: string = resolveDshHome(),
  platform: NodeJS.Platform = process.platform,
  profileName: string = PRODUCT_SERVER_PROFILE_NAME,
): PreparedProductServerProfile {
  return prepareProductProfile({ telemetryDisabled, home, platform, profileName, adapter: 'server' })
}

/** Expose the package anchor for focused resolution tests. */
export function desktopInstallAnchor(): string {
  return INSTALL_ANCHOR
}

/** Preserve the public manifest type in the declaration graph used by plugin tooling. */
export type DesktopProfileManifest = ProfileManifest
