import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FORBIDDEN_PACKAGED_CLIENT_BRANDING_MARKERS,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_PACKAGED_CLIENT_BRANDING_MARKERS,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedUnpackedRoot,
  verifyPackagedClientBranding,
  verifyPackagedPersistentBashPrompt,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
  type TextReader,
} from '../scripts/verify-packaged-runtime.ts'

function context(appOutDir: string, electronPlatformName: string): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return REQUIRED_PACKAGED_RUNTIME_ENTRIES.map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function completePackageResolver(unpackedRoot: string): PackageResolver {
  return specifier => join(unpackedRoot, 'resolved', `${specifier.replaceAll('/', '-')}.js`)
}

function validClientBundle(): string {
  return REQUIRED_PACKAGED_CLIENT_BRANDING_MARKERS.join('\n')
}

const persistentPrompt = '__DSH_PERSISTENT_BASH_PROMPT__ '

function validRuntimeText(filename: string): string {
  if (filename.endsWith('/lib/client.js')) return validClientBundle()
  if (filename.includes('/dsh-terminal-bash/')) {
    return `const CONTROLLED_PROMPT = ${JSON.stringify(persistentPrompt)};`
  }
  if (filename.includes('/dsh-tool-bash-persistent/')) {
    return `const SHELL_PROMPT = ${JSON.stringify(persistentPrompt)};`
  }
  throw new Error(`unexpected runtime text path: ${filename}`)
}

const SYNAPSE_RUNTIME_ENTRIES = [
  'node_modules/dsh-synapse/index.js',
  'node_modules/dsh-synapse/client.js',
  'node_modules/dsh-synapse/app.js',
  'node_modules/dsh-synapse/styles.css',
  'node_modules/dsh-synapse/cordis.patch.yml',
  'node_modules/dsh-synapse/package.json',
] as const

const readValidRuntime = vi.fn<TextReader>(validRuntimeText)

describe('packaged desktop runtime verification', () => {
  it('requires every Synapse runtime entry in both archive and unpacked trees', () => {
    for (const entry of SYNAPSE_RUNTIME_ENTRIES) {
      expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES).toContain(entry)
      expect(REQUIRED_UNPACKED_RUNTIME_ENTRIES).toContain(entry)
    }
  })

  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const exists = vi.fn<FileProbe>(() => true)
    const unpackedRoot = `${expectedPath}.unpacked`
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage, readValidRuntime)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + (platform === 'win32' ? REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES.length : 0),
    )
    expect(resolvePackage.mock.calls.map(([specifier]) => specifier))
      .toEqual(REQUIRED_UNPACKED_PACKAGE_SPECIFIERS)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it.each([
    'lib/client.js',
    'lib/desktop-runtime-environment.js',
    'lib/native-product-runtime.js',
    'lib/profile-service.js',
    'lib/pnpm.js',
    'lib/update-download.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([
    'package.json',
    'build/app-icon-mac.png',
    'build/tray-iconTemplate.png',
    'lib/terminal.js',
    'lib/update-download.js',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh-resident-operator-local/lib/startup.js',
    'node_modules/@nanmicoder/dsh-agent-teams/lib/index.js',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== missingPath,
      completePackageResolver(unpackedRoot),
      readValidRuntime,
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === 'dsh-plugin-desktop/profiles') {
        throw new Error('missing export')
      }
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      resolvePackage,
      readValidRuntime,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export dsh-plugin-desktop/profiles`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      resolvePackage,
      readValidRuntime,
    )).toThrow(
      `required package export @deepseek-ai/dsh-base/package.json resolved outside ${unpackedRoot}: ${escapedPath}`,
    )
  })

  it('accepts a packaged Client that mounts the bottom product marker', () => {
    const unpackedRoot = '/build/app.asar.unpacked'
    const readText = vi.fn<TextReader>(() => validClientBundle())

    expect(() => verifyPackagedClientBranding(unpackedRoot, readText)).not.toThrow()
    expect(readText).toHaveBeenCalledWith(join(unpackedRoot, 'lib/client.js'))
  })

  it.each(REQUIRED_PACKAGED_CLIENT_BRANDING_MARKERS)(
    'fails loud when packaged Client bottom-bar marker %s is absent',
    (missing) => {
      const source = REQUIRED_PACKAGED_CLIENT_BRANDING_MARKERS
        .filter(marker => marker !== missing)
        .join('\n')

      expect(() => verifyPackagedClientBranding('/build/app.asar.unpacked', () => source))
        .toThrow(`missing bottom-bar markers: ${missing}`)
    },
  )

  it.each(FORBIDDEN_PACKAGED_CLIENT_BRANDING_MARKERS)(
    'fails loud when packaged Client contains legacy sidebar marker %s',
    (forbidden) => {
      const source = `${validClientBundle()}\n${forbidden}`

      expect(() => verifyPackagedClientBranding('/build/app.asar.unpacked', () => source))
        .toThrow(`contains legacy sidebar markers: ${forbidden}`)
    },
  )

  it('accepts the shared persistent Bash prompt in the packaged runtime', () => {
    expect(() => verifyPackagedPersistentBashPrompt('/app.asar.unpacked', validRuntimeText))
      .not.toThrow()
  })

  it('rejects the published terminal prompt mismatch', () => {
    const mismatchedPromptReader: TextReader = filename => filename.includes('/dsh-terminal-bash/')
      ? 'const CONTROLLED_PROMPT = "dsh> ";'
      : `const SHELL_PROMPT = ${JSON.stringify(persistentPrompt)};`

    expect(() => verifyPackagedPersistentBashPrompt('/app.asar.unpacked', mismatchedPromptReader))
      .toThrow('packaged persistent Bash prompt contract is not aligned')
  })
})
