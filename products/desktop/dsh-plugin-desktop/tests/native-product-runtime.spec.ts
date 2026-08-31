import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installNativeProductRuntime,
  resolveNativeProductCommands,
} from '../src/native-product-runtime.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-products-'))
  roots.push(root)
  return root
}

function product(filename: string): void {
  mkdirSync(join(filename, '..'), { recursive: true })
  writeFileSync(filename, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(filename, 0o700)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native product runtime', () => {
  it('finds subscription CLIs outside a Finder-minimal PATH and projects only two wrappers', () => {
    const root = temporaryRoot()
    const homeDir = join(root, 'home')
    const claude = join(homeDir, '.local', 'bin', 'claude')
    const codex = join(homeDir, '.npm-global', 'bin', 'codex')
    product(claude)
    product(codex)
    const environment = { PATH: '/usr/bin:/bin' }
    const stateDir = join(root, 'state', 'products')

    const installed = installNativeProductRuntime({
      platform: 'darwin',
      homeDir,
      stateDir,
      environment,
    })

    expect(installed.commands).toEqual({ claude, codex })
    expect(environment.PATH).toBe(`${stateDir}${delimiter}/usr/bin:/bin`)
    expect(readFileSync(join(stateDir, 'claude'), 'utf8')).toContain(`exec '${claude}' "$@"`)
    expect(readFileSync(join(stateDir, 'codex'), 'utf8')).toContain(`exec '${codex}' "$@"`)
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(stateDir, 'claude')).mode & 0o777).toBe(0o700)

    installed.dispose()
    installed.dispose()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('prefers a user-owned product command over an inherited legacy command', () => {
    const root = temporaryRoot()
    const inherited = join(root, 'inherited')
    const homeDir = join(root, 'home')
    const inheritedCodex = join(inherited, 'codex')
    const standardCodex = join(homeDir, '.local', 'bin', 'codex')
    product(inheritedCodex)
    product(standardCodex)

    const resolved = resolveNativeProductCommands({
      platform: 'darwin',
      homeDir,
      environment: { PATH: `${inherited}:relative:` },
    })
    expect(resolved.codex).toBe(standardCodex)

    rmSync(standardCodex)
    expect(resolveNativeProductCommands({
      platform: 'darwin',
      homeDir,
      environment: { PATH: `${inherited}:relative:` },
    }).codex).toBe(inheritedCodex)

    const environment = { PATH: '/windows/path' }
    const installed = installNativeProductRuntime({
      platform: 'win32',
      homeDir,
      stateDir: join(root, 'unused'),
      environment,
    })
    expect(installed.commands).toEqual({})
    expect(environment.PATH).toBe('/windows/path')
    installed.dispose()
  })

  it('prefers the user-controlled npm installation over an app-managed standalone binary', () => {
    const root = temporaryRoot()
    const homeDir = join(root, 'home')
    const npmCodex = join(homeDir, '.npm-global', 'bin', 'codex')
    const standaloneCodex = join(homeDir, '.local', 'bin', 'codex')
    product(npmCodex)
    product(standaloneCodex)

    expect(resolveNativeProductCommands({
      platform: 'darwin',
      homeDir,
      environment: { PATH: '/usr/bin:/bin' },
    }).codex).toBe(npmCodex)
  })

  it('fails closed when the private runtime directory is a symlink', () => {
    const root = temporaryRoot()
    const target = join(root, 'target')
    const stateDir = join(root, 'runtime-products')
    mkdirSync(target)
    symlinkSync(target, stateDir)

    expect(() => installNativeProductRuntime({
      platform: 'darwin',
      homeDir: join(root, 'home'),
      stateDir,
      environment: { PATH: '/usr/bin' },
    })).toThrow('not a private directory')
  })
})
