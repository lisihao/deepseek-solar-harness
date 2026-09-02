import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const workspaceRoot = new URL('../', packageRoot)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  version?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
  scripts?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  build?: {
    productName?: unknown
    appId?: unknown
    asarUnpack?: unknown
    afterPack?: unknown
    electronFuses?: unknown
    files?: unknown
    mac?: { hardenedRuntime?: unknown; icon?: unknown; notarize?: unknown; target?: unknown }
    linux?: { icon?: unknown }
  }
  dependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}
const workspaceManifest = JSON.parse(readFileSync(new URL('package.json', workspaceRoot), 'utf8')) as {
  version?: unknown
  resolutions?: Record<string, unknown>
  scripts?: Record<string, unknown>
}

describe('published package surface', () => {
  it('registers both npm launcher names', () => {
    expect(manifest.name).toBe('dsh-plugin-desktop')
    expect(manifest.bin).toEqual({
      'dsh-plugin-desktop': 'lib/bin.js',
      'dsh-desktop': 'lib/bin.js',
      'dsh-product-server': 'lib/product-server-bin.js',
    })
  })

  it('exposes the Host plugin and desktop-owned client face', () => {
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./product-server', {
      types: './lib/types/product-server.d.ts',
      default: './lib/product-server.js',
    })
    expect(manifest.exports).not.toHaveProperty('./windows-pwsh-sandbox')
    expect(manifest.exports).toHaveProperty('./terminal', {
      types: './lib/types/terminal.d.ts',
      default: './lib/terminal.js',
    })
    expect(manifest.exports).toHaveProperty('./pnpm', {
      types: './lib/types/pnpm.d.ts',
      default: './lib/pnpm.js',
    })
    expect(manifest.exports).toHaveProperty('./profile-service', {
      types: './lib/types/profile-service.d.ts',
      default: './lib/profile-service.js',
    })
    expect(manifest.exports).toHaveProperty('./profiles', {
      types: './lib/types/profiles.d.ts',
      default: './lib/profiles.js',
    })
    expect(manifest.exports).toHaveProperty('./updates', {
      types: './lib/types/updates.d.ts',
      default: './lib/updates.js',
    })
    expect(manifest.exports).not.toHaveProperty('./windows-acl-runner')
    expect(manifest.exports).not.toHaveProperty('./desktop-cli')
    expect(manifest.exports).not.toHaveProperty('./desktop-runtime-environment')
    expect(manifest.exports).not.toHaveProperty('./desktop-terminal')
    expect(manifest.exports).not.toHaveProperty('./update-checker')
    expect(manifest.exports).not.toHaveProperty('./update-download')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    })
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop/terminal')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop/pnpm')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop/profiles')
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop/updates')
  })

  it('keeps unaudited marketplace packages out of the published runtime', () => {
    expect(manifest.dependencies).not.toHaveProperty('dshmarket')
    expect(manifest.optionalDependencies ?? {}).not.toHaveProperty('dshmarket')
  })

  it('aligns the terminal backend with the persistent Bash tool prompt', () => {
    const prompt = '__DSH_PERSISTENT_BASH_PROMPT__ '
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const dshRequire = createRequire(workspaceRequire.resolve('@deepseek-ai/dsh/package.json'))
    const terminalBash = readFileSync(
      dshRequire.resolve('@deepseek-ai/dsh-terminal-bash'),
      'utf8',
    )
    const persistentTool = readFileSync(
      dshRequire.resolve('@deepseek-ai/dsh-tool-bash-persistent'),
      'utf8',
    )

    expect(terminalBash).toContain(`const CONTROLLED_PROMPT = ${JSON.stringify(prompt)};`)
    expect(persistentTool).toContain(`const SHELL_PROMPT = ${JSON.stringify(prompt)};`)
  })

  it('keeps every SettingsScope consumer on the provider ABI release', () => {
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const webAppRequire = createRequire(workspaceRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
    const packageVersions = [
      ['provider', workspaceRequire, '@deepseek-ai/dsh-client-ui-settings'],
      ['general', webAppRequire, '@deepseek-ai/dsh-client-ui-settings-general'],
      ['agent-preset', webAppRequire, '@deepseek-ai/dsh-client-ui-agent-preset'],
      ['permission-presets', webAppRequire, '@deepseek-ai/dsh-client-ui-permission-presets'],
      ['settings-models', webAppRequire, '@deepseek-ai/dsh-client-ui-settings-models'],
      ['settings-plugins', webAppRequire, '@deepseek-ai/dsh-client-ui-settings-plugins'],
    ].map(([role, resolver, packageName]) => {
      const packageJson = JSON.parse(readFileSync(
        (resolver as NodeJS.Require).resolve(`${packageName as string}/package.json`),
        'utf8',
      )) as { version?: unknown }
      return [role, packageJson.version]
    })

    expect(Object.fromEntries(packageVersions)).toEqual({
      provider: '0.1.0-rc.6',
      general: '0.1.0-rc.6',
      'agent-preset': '0.1.0-rc.6',
      'permission-presets': '0.1.0-rc.6',
      'settings-models': '0.1.0-rc.6',
      'settings-plugins': '0.1.0-rc.6',
    })
  })

  it('keeps the complete registry runtime on one recorded DSH ABI release', () => {
    const upstream = JSON.parse(readFileSync(new URL('upstream.json', workspaceRoot), 'utf8')) as {
      runtimePackageVersion?: unknown
    }
    const lockText = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const versions = new Set(
      [...lockText.matchAll(/resolution: "@deepseek-ai\/dsh(?:-[^"@]+)?@npm:([^"#]+)"/gu)]
        .map(match => match[1]),
    )
    expect([...versions]).toEqual([upstream.runtimePackageVersion])
  })

  it('builds public Host plugins and their private native bootstraps', () => {
    const config = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')
    const frontendSetup = readFileSync(new URL('src/frontend-setup.ts', packageRoot), 'utf8')

    expect(config).not.toContain('windows-pwsh-sandbox')
    expect(config).not.toContain('windows-acl-runner')
    expect(config).toContain("'desktop-cli': 'src/desktop-cli.ts'")
    expect(config).toContain("name: `${PACKAGE_NAME}/frontend-setup-preload`")
    expect(config).toContain("entry: { 'frontend-setup-preload': 'src/frontend-setup-preload.ts' }")
    expect(config).toContain("entryFileNames: 'frontend-setup-preload.cjs'")
    expect(frontendSetup).toContain("new URL('./frontend-setup-preload.cjs', import.meta.url)")
    expect(config).toContain("'desktop-runtime-environment': 'src/desktop-runtime-environment.ts'")
    expect(config).toContain("'desktop-terminal': 'src/desktop-terminal.ts'")
    expect(config).toContain("'profile-manager': 'src/profile-manager.ts'")
    expect(config).toContain("'profile-service': 'src/profile-service.ts'")
    expect(config).toContain("'product-server': 'src/product-server.ts'")
    expect(config).toContain("entry: { 'product-server-bin': 'src/product-server-bin.ts' }")
    expect(config).toContain("pnpm: 'src/pnpm.ts'")
    expect(config).toContain("profiles: 'src/profiles.ts'")
    expect(config).toContain("terminal: 'src/terminal.ts'")
    expect(config).toContain("'update-download': 'src/update-download.ts'")
    expect(config).toContain("updates: 'src/updates.ts'")
  })

  it('installs the private pnpm PATH after the launch snapshot and before profile boot', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const snapshot = main.indexOf('const environment = loadLayeredEnv')
    const frontend = main.indexOf("if (deploymentState.role === 'frontend')")
    const localRuntime = main.indexOf('const electronVersion = process.versions.electron')
    const install = main.indexOf('const pnpmRuntime = installDesktopPnpmRuntime')
    const products = main.indexOf('const nativeProductRuntime = installNativeProductRuntime')
    const prepare = main.indexOf('const prepared = prepareDesktopProfile')
    const boot = main.indexOf('const ctx = await boot')

    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(frontend).toBeGreaterThan(snapshot)
    expect(localRuntime).toBeGreaterThan(frontend)
    expect(main.slice(frontend, localRuntime)).toMatch(/\n\s+return\n/)
    expect(install).toBeGreaterThan(frontend)
    expect(install).toBeGreaterThan(snapshot)
    expect(products).toBeGreaterThan(install)
    expect(prepare).toBeGreaterThan(products)
    expect(boot).toBeGreaterThan(prepare)
    expect(main).toContain("'dsh-plugin-desktop: packaged pnpm runtime PATH'")
    expect(main).toContain("'dsh-plugin-desktop: native product command PATH'")
    expect(main).toContain("process.env.DSH_BUILD_COMMIT ??= app.isPackaged ? `desktop-${app.getVersion()}` : 'development'")
    expect(main).toContain('disposePnpmRuntime?.()')
    expect(main).toContain('disposeNativeProductRuntime?.()')
  })

  it('fixes the installed application identity', () => {
    expect(manifest.version).toBe(workspaceManifest.version)
    expect(manifest.build?.productName).toBe('DSH Desktop')
    expect(manifest.build?.appId).toBe('ai.deepseek.dsh.desktop')
    expect(manifest.build?.asarUnpack).toEqual([
      'package.json',
      'cordis.patch.yml',
      'build/**',
      'lib/**',
      'vendor/agent-presets/**',
      'node_modules/**',
    ])
    expect(manifest.build?.electronFuses).toEqual({ runAsNode: true })
    expect(manifest.files).toEqual(expect.arrayContaining([
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'docs/**',
      'vendor/agent-presets/**',
      'vendor/dsh-packages/**',
    ]))
    expect(manifest.build?.files).toEqual([
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'cordis.patch.yml',
      'lib/**',
      'package.json',
      'vendor/agent-presets/**',
    ])
    expect(manifest.build?.mac?.icon).toBe('build/app-icon-mac.png')
    expect(manifest.build).not.toHaveProperty('win')
    expect(manifest.build).not.toHaveProperty('nsis')
    expect(manifest.build?.linux?.icon).toBe('build/app-icon.png')
  })

  it('separates unsigned smoke packaging from the signed macOS release', () => {
    const packageDir = readFileSync(new URL('scripts/package-dir.mjs', packageRoot), 'utf8')

    expect(manifest.scripts?.build).toContain('node scripts/generate-mac-app-icon.mjs')
    expect(manifest.scripts?.['package:dir']).toBe('yarn run build && node scripts/package-dir.mjs')
    expect(packageDir).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(packageDir).toContain('verify-packaged-node-pty.ts')
    expect(manifest.scripts?.['dist:mac']).toBe('node scripts/release-mac.ts')
    expect(manifest.scripts).not.toHaveProperty('dist:win')
    expect(manifest.scripts).not.toHaveProperty('check:win-package')
    expect(manifest.scripts?.['verify:cli']).toBe('node scripts/verify-cli-runtime.mjs')
    expect(manifest.scripts?.check).toContain('yarn run verify:cli')
    expect(workspaceManifest.scripts?.['dist:mac']).toBe('yarn workspace dsh-plugin-desktop dist:mac')
    expect(workspaceManifest.scripts).not.toHaveProperty('dist:win')
    expect(manifest.build?.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
    expect(manifest.build?.mac).toEqual(expect.objectContaining({
      hardenedRuntime: true,
      notarize: true,
      target: ['dir'],
    }))
    expect(manifest.devDependencies?.['@electron/asar']).toBe('3.4.1')
  })

  it('keeps one fixed brand-blue tray source for generated native assets', () => {
    const source = readFileSync(new URL('build/tray-icon.svg', packageRoot), 'utf8')

    expect(source.match(/#4D6BFE/gu)).toHaveLength(1)
    expect(source).not.toMatch(/<style\b|prefers-color-scheme/iu)
    for (const filename of [
      'tray-iconTemplate.png',
      'tray-iconTemplate@2x.png',
      'tray-icon-blue.png',
      'tray-icon-blue@1.25x.png',
      'tray-icon-blue@1.5x.png',
      'tray-icon-blue@2x.png',
    ]) {
      expect(readFileSync(new URL(`build/${filename}`, packageRoot)).byteLength).toBeGreaterThan(0)
    }
  })

  it('keeps the iOS Default source icon unmodified', () => {
    const digest = createHash('sha256')
      .update(readFileSync(new URL('build/app-icon.png', packageRoot)))
      .digest('hex')

    expect(digest).toBe('315fbc6e57ff1f34894f21f66fb7f9f26deccf78333c71fad21a6cec64e7de80')
  })

  it('generates a centered macOS icon with a 100-pixel visual inset', async () => {
    const source = await sharp(readFileSync(new URL('build/app-icon.png', packageRoot))).metadata()
    const icon = sharp(readFileSync(new URL('build/app-icon-mac.png', packageRoot)))
    const metadata = await icon.metadata()
    const { info } = await icon
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
      .toBuffer({ resolveWithObject: true })

    expect(metadata).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
    }))
    expect(metadata.icc).toEqual(source.icc)
    expect(info).toEqual(expect.objectContaining({
      width: 824,
      height: 824,
      trimOffsetLeft: -100,
      trimOffsetTop: -100,
    }))
  })

  it('keeps Electron out of production dependencies consumed by electron-builder', () => {
    expect(manifest.dependencies).not.toHaveProperty('electron')
    expect(manifest.peerDependencies?.electron).toBe('43.4.0')
    expect(manifest.devDependencies?.electron).toBe('43.4.0')
    expect(manifest.dependencies?.pnpm).toBe('11.7.0')
  })

  it('resolves electron-builder through the pinned app-builder-lib keychain patch', () => {
    const patchResolution = 'patch:app-builder-lib@npm%3A26.15.3#./patches/app-builder-lib@26.15.3.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/app-builder-lib@26.15.3.patch', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const electronBuilderManifest = workspaceRequire.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderManifest)
    const appBuilderManifest = electronBuilderRequire.resolve('app-builder-lib/package.json')
    const installedCodeSign = readFileSync(join(dirname(appBuilderManifest), 'out/codeSign/macCodeSign.js'), 'utf8')

    expect(workspaceManifest.resolutions).toMatchObject({
      'app-builder-lib@npm:26.15.3': patchResolution,
    })
    expect(lockfile).toContain('app-builder-lib@patch:app-builder-lib@npm%3A26.15.3#./patches/app-builder-lib@26.15.3.patch')
    expect(patch).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(patch).toContain('"-k", keychainPassword, keychainFile')
    expect(installedCodeSign).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(installedCodeSign).toContain('"-k", keychainPassword, keychainFile')
  })

  it('keeps unsupported Windows runtime packages out of the Desktop surface', () => {
    for (const packageName of [
      '@deepseek-ai/dsh-pwsh-local',
      '@deepseek-ai/dsh-pwsh-sandbox',
      '@deepseek-ai/dsh-sandbox-windows-acl',
      '@deepseek-ai/dsh-tool-pwsh',
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(packageName)
      expect(manifest.optionalDependencies ?? {}).not.toHaveProperty(packageName)
      expect(manifest.devDependencies ?? {}).not.toHaveProperty(packageName)
      expect(manifest.peerDependencies ?? {}).not.toHaveProperty(packageName)
    }
    expect(workspaceManifest.resolutions ?? {}).not.toHaveProperty(
      '@deepseek-ai/dsh-sandbox-windows-acl@npm:0.1.0-rc.6',
    )
    expect(workspaceManifest.resolutions ?? {}).not.toHaveProperty(
      '@deepseek-ai/dsh-sandbox-windows-acl@npm:^0.1.0-rc.6',
    )
  })
})
