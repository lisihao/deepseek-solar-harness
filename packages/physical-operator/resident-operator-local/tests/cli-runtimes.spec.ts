import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_METHODS } from '@deepseek-ai/dsh-subagent-codex'
import {
  CliRuntimeManager,
  cliRuntimesRoot,
  compareCliVersions,
  managedCliBinDir,
} from '../src/cli-runtimes.ts'
import { preferManagedCliRuntimes } from '../src/startup.ts'

const TARGET = `${process.platform === 'linux' ? 'linux' : 'darwin'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const TRIPLE = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'linux' ? 'unknown-linux-musl' : 'apple-darwin'}`
const ENV_KEYS = ['PATH', 'FAKE_CODEX_STATE', 'FAKE_CODEX_SCHEMA', 'FAKE_CODEX_UPDATE_TO', 'FAKE_CODEX_RESTART_TO'] as const

interface Package { readonly archive: Buffer; readonly integrity: string }

let root: string
let server: Server
let registryUrl: string
let routes: Map<string, { version: string; package?: string }>
let packages: Map<string, Package>
const savedEnv = new Map<string, string | undefined>()

function executable(path: string, lines: readonly string[]): void {
  writeFileSync(path, ['#!/bin/sh', ...lines, ''].join('\n'))
  chmodSync(path, 0o755)
}

function schema(omit?: string): string {
  const definitions = Object.fromEntries(Object.entries(CODEX_APP_SERVER_METHODS).map(([union, methods]) => [union, {
    oneOf: methods.filter(method => method !== omit).map(method => ({ properties: { method: { enum: [method] } } })),
  }]))
  const path = join(root, `schema-${(omit ?? 'full').replaceAll('/', '-')}.json`)
  writeFileSync(path, JSON.stringify({ definitions }))
  return path
}

function codexScript(version: string): string[] {
  return [
    'case "$1 $2 $3" in',
    `  "--version  ") echo "codex-cli ${version}" ;;`,
    '  "app-server generate-json-schema --out") cp "$FAKE_CODEX_SCHEMA" "$4/codex_app_server_protocol.schemas.json" ;;',
    '  "app-server daemon update") [ -n "$FAKE_CODEX_UPDATE_TO" ] && echo "$FAKE_CODEX_UPDATE_TO" > "$FAKE_CODEX_STATE"; exit 0 ;;',
    '  "app-server daemon restart") [ -n "$FAKE_CODEX_RESTART_TO" ] && echo "$FAKE_CODEX_RESTART_TO" > "$FAKE_CODEX_STATE"; exit 0 ;;',
    '  "app-server daemon version") [ -f "$FAKE_CODEX_STATE" ] || exit 3; printf \'{"appServerVersion":"%s","managedCodexPath":"/opt/codex/bin/codex"}\' "$(cat "$FAKE_CODEX_STATE")" ;;',
    '  *) exit 2 ;;',
    'esac',
  ]
}

function pack(name: string, build: (directory: string) => void): Package {
  const directory = join(root, `pack-${name}`)
  mkdirSync(join(directory, 'package'), { recursive: true })
  build(join(directory, 'package'))
  const archive = join(root, `${name}.tgz`)
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package'])
  const bytes = readFileSync(archive)
  return { archive: bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
}

function publishClaude(version: string, lines = [`echo "${version} (Claude Code)"`], integrity?: string): void {
  const name = `claude-${version}`
  const built = pack(name, (directory) => { executable(join(directory, 'claude'), lines) })
  packages.set(name, { archive: built.archive, integrity: integrity ?? built.integrity })
  routes.set('/@anthropic-ai%2Fclaude-code/latest', { version })
  routes.set(`/@anthropic-ai%2Fclaude-code-${TARGET}/${version}`, { version, package: name })
}

function publishCodex(version: string, options: { entrypoint?: string; reported?: string } = {}): void {
  const name = `codex-${version}`
  packages.set(name, pack(name, (directory) => {
    const vendor = join(directory, 'vendor', TRIPLE)
    mkdirSync(join(vendor, 'bin'), { recursive: true })
    writeFileSync(join(vendor, 'codex-package.json'), JSON.stringify(
      options.entrypoint === undefined ? { entrypoint: 'bin/codex' } : { entrypoint: options.entrypoint },
    ))
    executable(join(vendor, 'bin', 'codex'), codexScript(options.reported ?? version))
  }))
  routes.set('/@openai%2Fcodex/latest', { version })
  routes.set(`/@openai%2Fcodex/${version}-${TARGET}`, { version, package: name })
}

function manager(): CliRuntimeManager {
  return new CliRuntimeManager({ runtimesRoot: join(root, 'runtimes'), registryUrl: `${registryUrl}/`, downloadTimeoutMs: 30_000 })
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  root = mkdtempSync(join(tmpdir(), 'dsh-cli-runtimes-'))
  routes = new Map()
  packages = new Map()
  server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.startsWith('/tarballs/')) {
      const entry = packages.get(url.slice('/tarballs/'.length))
      response.writeHead(entry === undefined ? 404 : 200).end(entry?.archive)
      return
    }
    const route = routes.get(url)
    if (route === undefined) {
      response.writeHead(404).end('{}')
      return
    }
    const entry = route.package === undefined ? undefined : packages.get(route.package)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      version: route.version,
      dist: {
        tarball: `${registryUrl}/tarballs/${route.package ?? 'none'}`,
        integrity: entry?.integrity ?? 'sha512-root',
      },
    }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  registryUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const bin = join(root, 'system-bin')
  mkdirSync(bin)
  executable(join(bin, 'claude'), ['echo "2.1.239 (Claude Code)"'])
  executable(join(bin, 'codex'), codexScript('0.151.0'))
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter)
  process.env.FAKE_CODEX_STATE = join(root, 'daemon-version')
  process.env.FAKE_CODEX_SCHEMA = schema()
  writeFileSync(process.env.FAKE_CODEX_STATE, '0.149.1\n')
  delete process.env.FAKE_CODEX_UPDATE_TO
  delete process.env.FAKE_CODEX_RESTART_TO
})

afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('compareCliVersions', () => {
  it('orders dotted releases numerically and ignores prerelease suffixes', () => {
    expect(compareCliVersions('2.1.281', '2.1.239')).toBeGreaterThan(0)
    expect(compareCliVersions('0.99.0', '0.156.1')).toBeLessThan(0)
    expect(compareCliVersions('1.2', '1.2.0')).toBe(0)
    expect(compareCliVersions('0.155.0-alpha', '0.155.0')).toBe(0)
    expect(compareCliVersions('x.1', '0.1')).toBe(0)
  })
})

describe('managed runtime directories', () => {
  it('keeps runtimes beside the Resident root and puts their wrappers first on the daemon PATH', () => {
    const runtimes = cliRuntimesRoot('/home/owner/.dsh/resident-operators')
    expect(runtimes).toBe('/home/owner/.dsh/runtimes')
    const environment: NodeJS.ProcessEnv = { PATH: ['/usr/bin', managedCliBinDir(runtimes), ''].join(delimiter) }
    preferManagedCliRuntimes(environment, '/home/owner/.dsh/resident-operators')
    expect(environment.PATH).toBe(['/home/owner/.dsh/runtimes/bin', '/usr/bin'].join(delimiter))
    const empty: NodeJS.ProcessEnv = {}
    preferManagedCliRuntimes(empty, '/r/resident-operators')
    expect(empty.PATH).toBe('/r/runtimes/bin')
  })
})

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('CliRuntimeManager', () => {
  it('reports system versions against the registry and switches Claude Code to a qualified managed copy', async () => {
    publishClaude('2.1.300')
    publishCodex('0.160.0')
    mkdirSync(join(root, 'runtimes', 'claude-code', '2.1.250'), { recursive: true })
    const runtimes = manager()
    await expect(runtimes.statuses()).resolves.toEqual([
      { product: 'claude-code', currentVersion: '2.1.239', latestVersion: '2.1.300', updateAvailable: true, managed: false },
      { product: 'codex', currentVersion: '0.149.1', latestVersion: '0.160.0', updateAvailable: true, managed: false },
    ])

    const first = runtimes.update('claude-code')
    expect(runtimes.update('claude-code')).toBe(first)
    await expect(first).resolves.toEqual({ product: 'claude-code', version: '2.1.300', status: 'activated' })
    const wrapper = join(managedCliBinDir(join(root, 'runtimes')), 'claude')
    expect(execFileSync(wrapper, ['--version'], { encoding: 'utf8' }).trim()).toBe('2.1.300 (Claude Code)')
    expect(readdirSync(join(root, 'runtimes', 'claude-code'))).toEqual(['2.1.300'])
    await expect(runtimes.statuses()).resolves.toContainEqual({
      product: 'claude-code', currentVersion: '2.1.300', latestVersion: '2.1.300', updateAvailable: false, managed: true,
    })
  })

  it('leaves the running Claude Code in place when the candidate is outside the qualified release line', async () => {
    publishClaude('3.0.0')
    await expect(manager().update('claude-code')).resolves.toEqual({
      product: 'claude-code',
      version: '3.0.0',
      status: 'incompatible',
      reason: 'Claude Code 3.0.0 (Claude Code) is outside the release line this DSH build qualifies',
    })
    expect(existsSync(managedCliBinDir(join(root, 'runtimes')))).toBe(false)
    expect(readdirSync(join(root, 'runtimes', 'claude-code'))).toEqual([])
  })

  it('rejects a download whose sha512 does not match the registry metadata', async () => {
    publishClaude('2.1.300', undefined, 'sha512-tampered')
    await expect(manager().update('claude-code')).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(existsSync(join(root, 'runtimes', 'claude-code'))).toBe(false)
  })

  it('reports registry failures as unavailable updates and status errors', async () => {
    await expect(manager().update('claude-code')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    routes.set('/@anthropic-ai%2Fclaude-code/latest', { version: '2.1.300', package: 'missing' })
    routes.set(`/@anthropic-ai%2Fclaude-code-${TARGET}/2.1.300`, { version: '2.1.300', package: 'missing' })
    await expect(manager().update('claude-code')).rejects.toThrow('returned HTTP 404')
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter)
    const [claude] = await manager().statuses()
    expect(claude).toMatchObject({ product: 'claude-code', latestVersion: '2.1.300', updateAvailable: true, managed: false })
    expect(claude?.error).toMatch(/not found/u)
  })

  it('rejects registry metadata without sha512 package fields', async () => {
    server.removeAllListeners('request')
    server.on('request', (_request, response) => { response.writeHead(200).end('{"version":"1.0.0"}') })
    await expect(manager().update('codex')).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  })

  it('activates a qualified Codex candidate through the daemon update and falls back to a restart', async () => {
    publishCodex('0.160.0')
    process.env.FAKE_CODEX_UPDATE_TO = '0.160.0'
    await expect(manager().update('codex')).resolves.toEqual({ product: 'codex', version: '0.160.0', status: 'activated' })
    expect(readFileSync(process.env.FAKE_CODEX_STATE ?? '', 'utf8').trim()).toBe('0.160.0')
    expect(readdirSync(join(root, 'runtimes', 'codex'))).toEqual([])

    publishCodex('0.161.0')
    delete process.env.FAKE_CODEX_UPDATE_TO
    process.env.FAKE_CODEX_RESTART_TO = '0.161.0'
    await expect(manager().update('codex')).resolves.toMatchObject({ version: '0.161.0', status: 'activated' })

    publishCodex('0.162.0')
    await expect(manager().update('codex')).rejects.toThrow('daemon reports 0.161.0 after updating to 0.162.0')
  })

  it('refuses a Codex candidate that lacks a required method or misreports its version', async () => {
    publishCodex('0.160.0')
    process.env.FAKE_CODEX_SCHEMA = schema('turn/interrupt')
    await expect(manager().update('codex')).resolves.toEqual({
      product: 'codex',
      version: '0.160.0',
      status: 'incompatible',
      reason: 'Codex 0.160.0 app-server lacks required methods: ClientRequest:turn/interrupt',
    })
    expect(readFileSync(process.env.FAKE_CODEX_STATE ?? '', 'utf8').trim()).toBe('0.149.1')

    process.env.FAKE_CODEX_SCHEMA = schema()
    publishCodex('0.160.0', { reported: '0.159.0' })
    await expect(manager().update('codex')).resolves.toMatchObject({
      status: 'incompatible',
      reason: 'Codex package 0.160.0 reports codex-cli 0.159.0',
    })
  })

  it('rejects a Codex package whose entrypoint leaves the package', async () => {
    publishCodex('0.160.0', { entrypoint: '../../outside' })
    await expect(manager().update('codex')).rejects.toThrow('no relative entrypoint')
    publishCodex('0.160.0', { entrypoint: '/bin/sh' })
    await expect(manager().update('codex')).rejects.toThrow('no relative entrypoint')
  })

  it('reads the Codex CLI version when no daemon reports one, and refuses unsupported platforms', async () => {
    rmSync(process.env.FAKE_CODEX_STATE ?? '')
    publishCodex('0.151.0')
    await expect(manager().statuses()).resolves.toContainEqual({
      product: 'codex', currentVersion: '0.151.0', latestVersion: '0.151.0', updateAvailable: false, managed: false,
    })
    const unsupported = new CliRuntimeManager({
      runtimesRoot: join(root, 'runtimes'), registryUrl, downloadTimeoutMs: 30_000, platform: 'win32', arch: 'x64',
    })
    await expect(unsupported.update('codex')).rejects.toThrow('unsupported on win32-x64')
    const linux = new CliRuntimeManager({
      runtimesRoot: join(root, 'runtimes'), registryUrl, downloadTimeoutMs: 30_000, platform: 'linux', arch: 'arm64',
    })
    await expect(linux.update('codex')).rejects.toThrow('@openai/codex@0.151.0-linux-arm64 returned HTTP 404')
    publishClaude('2.1.300')
    const intel = new CliRuntimeManager({
      runtimesRoot: join(root, 'runtimes'), registryUrl, downloadTimeoutMs: 30_000, platform: 'darwin', arch: 'x64',
    })
    await expect(intel.update('claude-code')).rejects.toThrow('claude-code-darwin-x64@2.1.300 returned HTTP 404')
    const legacy = new CliRuntimeManager({
      runtimesRoot: join(root, 'runtimes'), registryUrl, downloadTimeoutMs: 30_000, platform: 'darwin', arch: 'ia32',
    })
    await expect(legacy.update('claude-code')).rejects.toThrow('unsupported on darwin-ia32')
  })
})
