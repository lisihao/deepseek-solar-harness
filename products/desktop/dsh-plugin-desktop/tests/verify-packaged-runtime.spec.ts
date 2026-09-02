import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FORBIDDEN_PACKAGED_CLIENT_BRANDING_MARKERS,
  FORBIDDEN_PACKAGED_WINDOWS_PACKAGES,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_PACKAGED_CLIENT_BRANDING_MARKERS,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
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

function validPhysicalFileProbe(unpackedRoot: string, missingPath?: string): FileProbe {
  return filename => filename !== missingPath && !FORBIDDEN_PACKAGED_WINDOWS_PACKAGES.some(
    packageName => filename === join(unpackedRoot, 'node_modules', packageName),
  )
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

const readValidRuntime = vi.fn<TextReader>(validRuntimeText)

describe('packaged desktop runtime verification', () => {
  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'linux',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries())

    const unpackedRoot = `${expectedPath}.unpacked`
    const exists = vi.fn<FileProbe>(validPhysicalFileProbe(unpackedRoot))
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage, readValidRuntime)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length + FORBIDDEN_PACKAGED_WINDOWS_PACKAGES.length,
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

    const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', 'darwin'))
    expect(() => verifyPackagedRuntime(
      context('/build', 'darwin'),
      () => entries,
      validPhysicalFileProbe(unpackedRoot),
    ))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each(FORBIDDEN_PACKAGED_WINDOWS_PACKAGES)(
    'rejects the disabled package %s from app.asar',
    (packageName) => {
      const runtimeContext = context('/build', 'darwin')
      const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
      const packageEntry = `/node_modules/${packageName}/package.json`

      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => [...completeArchiveEntries(), packageEntry],
        validPhysicalFileProbe(unpackedRoot),
      )).toThrow(`contains forbidden Windows packages in ASAR: ${packageName}`)
    },
  )

  it('does not reject an unrelated archive entry whose name mentions a disabled package', () => {
    const runtimeContext = context('/build', 'darwin')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => [
        ...completeArchiveEntries(),
        'vendor/agent-presets/anchored-standard/dsh-pwsh-local-reference.txt',
      ],
      validPhysicalFileProbe(unpackedRoot),
      completePackageResolver(unpackedRoot),
      readValidRuntime,
    )).not.toThrow()
  })

  it.each(FORBIDDEN_PACKAGED_WINDOWS_PACKAGES)(
    'rejects the disabled package %s from app.asar.unpacked/node_modules',
    (packageName) => {
      const runtimeContext = context('/build', 'darwin')
      const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
      const packagePath = join(unpackedRoot, 'node_modules', packageName)
      const exists: FileProbe = filename =>
        filename === packagePath || validPhysicalFileProbe(unpackedRoot)(filename)

      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        exists,
      )).toThrow(
        `contains forbidden Windows packages in app.asar.unpacked/node_modules: ${packageName}`,
      )
    },
  )

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
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'darwin')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      validPhysicalFileProbe(unpackedRoot, missingPath),
      completePackageResolver(unpackedRoot),
      readValidRuntime,
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'darwin')
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
      validPhysicalFileProbe(unpackedRoot),
      resolvePackage,
      readValidRuntime,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export dsh-plugin-desktop/profiles`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'darwin')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      validPhysicalFileProbe(unpackedRoot),
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
