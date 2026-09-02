import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_PACKAGE_NAME,
  PRODUCT_SERVER_PROFILE_NAME,
  desktopShellModeFromSettings,
  desktopBundleList,
  ensureDesktopProfile,
  ensureProductServerProfile,
  prepareDesktopProfile,
  prepareProductServerProfile,
  readDesktopShellMode,
} from '../src/profile.ts'
import { PRODUCT_BUNDLE_ROW_IDS } from '../src/product-bundles.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', () => {
  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', () => {
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      '@liustack/modlens',
      'dsh-memory-evolve',
      '@ycp424c/dsh-luna-vision-bridge',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-one',
      'third-party-two',
    ])
  })

  it('repairs a base-only CLI profile without replacing dependencies', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dependencies: { 'third-party-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-plugin'] } },
      custom: { preserved: true },
    }, undefined, 2) + '\n')

    ensureDesktopProfile(home)
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      custom: { preserved: boolean }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    expect(repaired.dependencies).toEqual({ 'third-party-plugin': '^1.2.3' })
    expect(repaired.custom.preserved).toBe(true)
  })

  it('composes the complete product on Server without Electron-owned rows', () => {
    const home = temporaryHome()
    const dir = ensureProductServerProfile(home)
    const prepared = prepareProductServerProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])
    const rowIds = new Set(rows.map(row => row.id))

    expect(dir).toBe(join(home, 'profiles', PRODUCT_SERVER_PROFILE_NAME))
    for (const rowId of PRODUCT_BUNDLE_ROW_IDS.values()) expect(rowIds).toContain(rowId)
    expect(rows.find(row => row.id === 'resident-operators')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-resident-operator-local',
      config: expect.objectContaining({ connectTimeoutMs: 15_000 }),
    }))
    expect(rows.find(row => row.id === 'orchestration-local')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-orchestration-local',
      config: expect.objectContaining({ autoStart: true }),
    }))
    expect(rows.find(row => row.id === 'connection')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-connection',
      inject: ['webRuntime', 'webStartup', 'residentOperators', 'orchestrations', 'remoteOperatorHost'],
    }))
    expect(rows.find(row => row.id === 'ui-remote-modules')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-remote-modules',
      disabled: false,
    }))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
      disabled: false,
    }))
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'product-server-directory-picker-browse-host')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
    }))
    expect(rows.find(row => row.id === 'product-server-directory-picker-browse-surface')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    }))
    for (const desktopRow of [
      'desktop-shell',
      'desktop-terminal',
      'desktop-pnpm',
      'desktop-profiles',
      'desktop-updates',
    ]) expect(rowIds).not.toContain(desktopRow)
  })

  it('selects the native Codex operator by default on Desktop and Product Server', () => {
    const home = temporaryHome()
    const desktopRows = composeEntries([prepareDesktopProfile(undefined, home, 'darwin').patches])
    const serverRows = composeEntries([prepareProductServerProfile(undefined, home, 'darwin').patches])

    for (const rows of [desktopRows, serverRows]) {
      expect(rows.find(row => row.id === 'agent-default-model')).toEqual(expect.objectContaining({
        name: '@deepseek-ai/dsh-agent-default-model',
        config: {
          provider: 'dsh-physical-operator',
          model: 'codex',
        },
      }))
    }
  })

  it('keeps the Product Server compatibility layout when Desktop settings request advanced', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')

    const prepared = prepareProductServerProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('compatibility')
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).not.toBe(true)
    expect(rows.find(row => row.id === 'desktop-shell')).toBeUndefined()
  })

  it('keeps every sealed product row identical across Desktop and Product Server', () => {
    const home = temporaryHome()
    const desktop = composeEntries([prepareDesktopProfile(undefined, home, 'darwin').patches])
    const server = composeEntries([prepareProductServerProfile(undefined, home, 'darwin').patches])
    const desktopRows = new Map(desktop.map(row => [row.id, row]))
    const serverRows = new Map(server.map(row => [row.id, row]))

    for (const rowId of PRODUCT_BUNDLE_ROW_IDS.values()) {
      expect(serverRows.get(rowId), rowId).toEqual(desktopRows.get(rowId))
    }

    const adapterRows = new Set([
      'webserver',
      'web-runtime',
      'connection',
      'directory-picker',
      'desktop-shell',
      'desktop-terminal',
      'desktop-pnpm',
      'desktop-profiles',
      'desktop-updates',
      'desktop-directory-picker-browse-host',
      'desktop-directory-picker-browse-surface',
      'product-server-directory-picker-browse-host',
      'product-server-directory-picker-browse-surface',
    ])
    const sharedIds = new Set([...desktopRows.keys(), ...serverRows.keys()])
    for (const rowId of sharedIds) {
      if (adapterRows.has(rowId)) continue
      expect(serverRows.get(rowId), rowId).toEqual(desktopRows.get(rowId))
    }
  })

  it('rejects malformed persistent bundle metadata', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  it('assembles the Host shell without replacing the upstream client shell', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'compatibility' },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'webserver',
      config: { host: '127.0.0.1', port: 0 },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'agent-presets',
      config: expect.objectContaining({
        roots: [
          expect.objectContaining({ path: expect.stringContaining('vendor/agent-presets'), trust: 'system' }),
          expect.objectContaining({ path: expect.stringContaining('config/agent-presets'), trust: 'system' }),
        ],
      }),
    }))
    expect(readFileSync(prepared.rootConfig, 'utf8')).toBe('[]\n')
    expect(prepared.homeDir).toBe(home)
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(
      prepared.profile.dir,
      '.dsh-product-runtime',
      'package.json',
    ))
    expect(prepared.mode).toBe('compatibility')

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      expect(matching[0]?.disabled).toBeFalsy()
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'desktop-terminal')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/terminal',
      disabled: { __jsExpr: "process.platform === 'linux'" },
    }))
    expect(rows.find(row => row.id === 'desktop-pnpm')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/pnpm',
    }))
    expect(rows.find(row => row.id === 'desktop-updates')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/updates',
    }))
    expect(rows.find(row => row.id === 'desktop-profiles')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/profiles',
    }))
    expect(rows.find(row => row.id === 'resident-operators')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-resident-operator-local',
      config: expect.objectContaining({
        autoStart: true,
        connectTimeoutMs: 15_000,
        driverModules: [],
      }),
    }))
    expect(rows.find(row => row.id === 'physical-operator-dual-mode')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-physical-operator-resident',
      config: expect.objectContaining({ operators: expect.arrayContaining([
        expect.objectContaining({ id: 'codex', residentProvider: 'codex' }),
        expect.objectContaining({ id: 'claude-code', residentProvider: 'claude-code' }),
      ]) }),
    }))
    expect(rows.find(row => row.id === 'ui-physical-operator')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-ui-physical-operator',
    }))
    expect(rows.find(row => row.id === 'orchestration-local')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-orchestration-local',
      config: expect.objectContaining({ autoStart: true }),
    }))
    expect(rows.find(row => row.id === 'tool-orchestration')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-orchestration',
    }))
    expect(rows.find(row => row.id === 'ui-orchestration')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-ui-orchestration',
    }))
    expect(rows.find(row => row.id === 'agent-teams')).toEqual(expect.objectContaining({
      name: '@nanmicoder/dsh-agent-teams',
      config: expect.objectContaining({ memberPersonaPlacement: 'prompt' }),
    }))
    expect(rows.find(row => row.id === 'remote-web-ui')).toEqual(expect.objectContaining({
      name: '@linxin666/dsh-remote-web-ui',
    }))
    expect(rows.find(row => row.id === 'plugin-console')).toEqual(expect.objectContaining({
      name: '@vlln/plugin-console',
      disabled: false,
    }))
    expect(rows.find(row => row.id === 'web-billing')).toEqual(expect.objectContaining({
      name: 'dsh-web-billing',
    }))
    for (const [id, name] of [
      ['genui', '@omdsh-dev/dsh-genui'],
      ['tool-plugin-check', '@omdsh-dev/dsh-plugin-check'],
      ['llm-fallbacks', 'dsh-llm-fallbacks'],
      ['tool-stat', '@deepseek-ai/dsh-tool-stat'],
      ['tool-time', '@deepseek-ai/dsh-tool-time'],
      ['tool-regex', '@deepseek-ai/dsh-tool-regex'],
      ['tool-markdown', '@deepseek-ai/dsh-tool-markdown'],
      ['codegraph', 'dsh-codegraph'],
      ['mnemon', 'dsh-mnemon'],
      ['aegis-method-pack', 'aegis/extensions/dsh/index.js'],
      ['better-sidebar', 'dsh-better-sidebar'],
    ] as const) {
      expect(rows.find(row => row.id === id)).toEqual(expect.objectContaining({ name }))
    }
    expect(rows.map(row => row.id)).not.toContain('dsh-memory-evolve')
    expect(rows.map(row => row.id)).not.toContain('luna-vision-bridge')
    expect(rows.map(row => row.id)).not.toContain('modlens')
    expect(rows.find(row => row.id === 'code-harness-governance')).toEqual(expect.objectContaining({
      name: '@lisihao/dsh-code-harness-governance',
      config: expect.objectContaining({ strict: true }),
    }))
    expect(rows.find(row => row.id === 'code-harness-governance-invariant')).toEqual(expect.objectContaining({
      name: '@lisihao/dsh-code-harness-governance/invariant',
    }))
    expect(rows.find(row => row.id === 'ui-remote-modules')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-remote-modules',
      disabled: false,
      config: expect.objectContaining({
        instances: [],
      }),
    }))
  })

  it('preserves user-owned Remote Module targets without supplying public defaults', () => {
    const home = temporaryHome()
    const profileDir = ensureDesktopProfile(home)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: ui-remote-modules',
      '  config:',
      '    instances:',
      '      - id: private-workspace',
      '        label: Private Workspace',
      '        url: http://127.0.0.1:19001/',
      '        relayPort: 29001',
      '        order: 100',
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])
    expect(rows.find(row => row.id === 'ui-remote-modules')?.config).toEqual(expect.objectContaining({
      instances: [expect.objectContaining({ id: 'private-workspace', relayPort: 29001 })],
    }))
  })

  it('boots a selected Web profile without overriding its compatibility UI rows', () => {
    const home = temporaryHome()
    const webDir = join(home, 'profiles', 'web')
    const bundles = PROFILE_TEMPLATES.web
    if (bundles === undefined) throw new Error('test requires the shipped Web template')
    initProfile(webDir, bundles)
    writeFileSync(join(webDir, 'cordis.patch.yml'), [
      '- id: ui-layout',
      "  name: '@deepseek-ai/dsh-client-ui-layout'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-layout',
      "      name: 'third-party-layout'",
      '    - id: plugin-console',
      "      name: '@dsh-external/plugin-console'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const rows = composeEntries([prepared.patches])

    expect(prepared.profile.name).toBe('web')
    expect(rows.find(row => row.id === 'ui-layout')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'third-party-layout')).toEqual({
      id: 'third-party-layout',
      name: 'third-party-layout',
    })
    expect(rows.find(row => row.id === 'plugin-console')).toEqual(expect.objectContaining({
      name: '@vlln/plugin-console',
      disabled: false,
    }))
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop',
      config: expect.objectContaining({ mode: 'compatibility' }),
    }))
  })

  it('does not duplicate a product bundle already recorded by the selected profile', () => {
    const home = temporaryHome()
    const webDir = join(home, 'profiles', 'web-with-teams')
    const bundles = PROFILE_TEMPLATES.web
    if (bundles === undefined) throw new Error('test requires the shipped Web template')
    initProfile(webDir, [...bundles, '@nanmicoder/dsh-agent-teams'])
    writeFileSync(join(webDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: remote-web-ui',
      "      name: '@linxin666/dsh-remote-web-ui'",
      '    - id: dsh-memory-evolve',
      '      name: dsh-memory-evolve',
      '      config:',
      '        reviewEnabled: true',
      '    - id: modlens',
      "      name: '@liustack/modlens'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'web-with-teams')
    const rows = composeEntries([prepared.patches])

    expect(rows.filter(row => row.id === 'agent-teams')).toHaveLength(1)
    expect(rows.find(row => row.id === 'agent-teams')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ memberPersonaPlacement: 'prompt' }),
    }))
    expect(rows.filter(row => row.id === 'resident-operators')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'ui-physical-operator')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'orchestration-local')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'remote-web-ui')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'ui-remote-modules')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'dsh-memory-evolve')).toHaveLength(1)
    expect(rows.find(row => row.id === 'dsh-memory-evolve')).toEqual(expect.objectContaining({
      disabled: true,
      config: { reviewEnabled: true },
    }))
    expect(rows.find(row => row.id === 'modlens')).toEqual(expect.objectContaining({
      name: '@liustack/modlens',
      disabled: true,
    }))
  })

  it('projects advanced YAML settings into the Host and client Loader rows', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('advanced')
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ mode: 'advanced' }),
    }))
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ dshHome: home }),
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
  })

  it('reads JSON settings and defaults an absent desktop namespace to compatibility', () => {
    const home = temporaryHome()
    const path = join(home, 'desktop-settings.json')
    writeFileSync(path, JSON.stringify({ 'dsh-desktop': { mode: 'advanced' } }))

    expect(readDesktopShellMode({ path })).toBe('advanced')
    expect(desktopShellModeFromSettings({ unrelated: { enabled: true } })).toBe('compatibility')
  })

  it('rejects invalid settings roots, sections, modes, and YAML', () => {
    expect(() => desktopShellModeFromSettings([])).toThrow('must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': true })).toThrow('settings must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': { mode: 'glass' } })).toThrow(
      'must be "compatibility" or "advanced"',
    )

    const home = temporaryHome()
    const path = join(home, 'invalid.yaml')
    writeFileSync(path, 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({ path })).toThrow('invalid settings document')
  })

})
