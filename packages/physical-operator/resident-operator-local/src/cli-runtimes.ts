/**
 * Check, download, qualify, and activate native product CLIs.
 *
 * Claude Code runs from a DSH-managed copy under `<runtimes>/claude-code/<version>`
 * exposed through the `<runtimes>/bin/claude` wrapper that the Resident daemon
 * puts first on its PATH. Codex execution goes through Codex's shared
 * app-server daemon, which serves the package Codex itself manages, so a
 * qualified Codex candidate is activated with Codex's own
 * `app-server daemon update`.
 *
 * @module @deepseek-ai/dsh-resident-operator-local/cli-runtimes
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  ResidentOperatorError,
  type ResidentCliProduct,
  type ResidentCliRuntimeStatus,
  type ResidentCliUpdateResult,
} from '@deepseek-ai/dsh-resident-operator'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import {
  claudeCliCompatible,
  codexDaemonVersion,
  codexProtocol,
  resolveProductExecutable,
} from './drivers.ts'

const execFileAsync = promisify(execFile)
const PRODUCT_COMMANDS = { 'claude-code': 'claude', codex: 'codex' } as const satisfies Record<ResidentCliProduct, string>
const PRODUCT_ORDER: readonly ResidentCliProduct[] = ['claude-code', 'codex']
const VERSION_TIMEOUT_MS = 15_000

/** Registry and platform inputs of one CLI runtime manager. */
export interface CliRuntimeOptions {
  /** DSH-owned directory holding managed runtimes and the `bin` wrappers. */
  readonly runtimesRoot: string
  /** npm-compatible registry base URL. */
  readonly registryUrl: string
  /** Bound on each registry request, download, and Codex daemon update. */
  readonly downloadTimeoutMs: number
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

interface PlatformTarget {
  readonly claudePackage: string
  readonly codexSuffix: string
  readonly codexTriple: string
}

interface RegistryVersion {
  readonly version: string
  readonly tarball: string
  readonly integrity: string
}

/**
 * Directory holding DSH-managed runtimes beside a Resident daemon root.
 * @param residentRoot - `<dshHome>/resident-operators` daemon state root.
 * @returns `<dshHome>/runtimes`.
 */
export function cliRuntimesRoot(residentRoot: string): string {
  return join(dirname(residentRoot), 'runtimes')
}

/**
 * Directory whose command wrappers select the active managed runtimes.
 * @param runtimesRoot - directory returned by `cliRuntimesRoot`.
 * @returns the wrapper directory the Resident daemon prepends to PATH.
 */
export function managedCliBinDir(runtimesRoot: string): string {
  return join(runtimesRoot, 'bin')
}

/**
 * Compare two dotted numeric release versions, ignoring prerelease suffixes.
 * @param left - first version such as `2.1.281`.
 * @param right - second version.
 * @returns a negative, zero, or positive number as `left` is older, equal, or newer.
 */
export function compareCliVersions(left: string, right: string): number {
  const parts = (value: string) => (value.split(/[-+]/u)[0] ?? '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function platformTarget(platform: NodeJS.Platform, arch: string): PlatformTarget {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  const triple = cpu === 'arm64' ? 'aarch64' : 'x86_64'
  if (cpu !== undefined && platform === 'darwin') {
    return { claudePackage: `@anthropic-ai/claude-code-darwin-${cpu}`, codexSuffix: `darwin-${cpu}`, codexTriple: `${triple}-apple-darwin` }
  }
  if (cpu !== undefined && platform === 'linux') {
    return { claudePackage: `@anthropic-ai/claude-code-linux-${cpu}`, codexSuffix: `linux-${cpu}`, codexTriple: `${triple}-unknown-linux-musl` }
  }
  throw new ResidentOperatorError(`native CLI runtimes are unsupported on ${platform}-${arch}`, 'RUNTIME_UNAVAILABLE')
}

function recordField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : undefined
}

async function run(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    env: scrubbedParentEnv(),
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Owner of the DSH-managed native CLI runtimes under one DSH home. */
export class CliRuntimeManager {
  private readonly target: () => PlatformTarget
  private readonly updates = new Map<ResidentCliProduct, Promise<ResidentCliUpdateResult>>()

  constructor(private readonly options: CliRuntimeOptions) {
    this.target = () => platformTarget(options.platform ?? process.platform, options.arch ?? process.arch)
  }

  /**
   * Report each product's running and newest published version.
   * @returns one status per product; probe failures land in `error`.
   */
  async statuses(): Promise<ResidentCliRuntimeStatus[]> {
    return Promise.all(PRODUCT_ORDER.map(async (product) => {
      const [current, latest] = await Promise.allSettled([this.current(product), this.latest(product)])
      const currentVersion = current.status === 'fulfilled' ? current.value.version : undefined
      const latestVersion = latest.status === 'fulfilled' ? latest.value : undefined
      const failure = [current, latest].find(result => result.status === 'rejected')
      return {
        product,
        ...currentVersion === undefined ? {} : { currentVersion },
        ...latestVersion === undefined ? {} : { latestVersion },
        updateAvailable: latestVersion !== undefined
          && (currentVersion === undefined || compareCliVersions(latestVersion, currentVersion) > 0),
        managed: current.status === 'fulfilled' && current.value.managed,
        ...failure === undefined ? {} : {
          error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        },
      }
    }))
  }

  /**
   * Download, qualify, and activate the newest published CLI for one product.
   * Concurrent calls for the same product share one update.
   * @param product - native product to update.
   * @returns the candidate version and whether it was activated.
   */
  update(product: ResidentCliProduct): Promise<ResidentCliUpdateResult> {
    const pending = this.updates.get(product)
    if (pending !== undefined) return pending
    const update = (product === 'claude-code' ? this.updateClaude() : this.updateCodex())
      .finally(() => { this.updates.delete(product) })
    this.updates.set(product, update)
    return update
  }

  private async current(product: ResidentCliProduct): Promise<{ version: string; managed: boolean }> {
    if (product === 'codex') {
      const daemon = await codexDaemonVersion()
      if (daemon !== undefined) return { version: daemon.appServerVersion, managed: false }
      const output = await run(resolveProductExecutable('codex'), ['--version'], VERSION_TIMEOUT_MS)
      return { version: output.replace(/^codex-cli\s+/u, ''), managed: false }
    }
    const wrapper = join(managedCliBinDir(this.options.runtimesRoot), PRODUCT_COMMANDS[product])
    const managed = existsSync(wrapper)
    const output = await run(managed ? wrapper : resolveProductExecutable('claude'), ['--version'], VERSION_TIMEOUT_MS)
    return { version: output.replace(/\s+\(Claude Code\)$/u, ''), managed }
  }

  private async latest(product: ResidentCliProduct): Promise<string> {
    const name = product === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex'
    return (await this.registryVersion(name, 'latest')).version
  }

  private async registryVersion(name: string, tag: string): Promise<RegistryVersion> {
    const url = `${this.options.registryUrl.replace(/\/+$/u, '')}/${name.replace('/', '%2F')}/${encodeURIComponent(tag)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(this.options.downloadTimeoutMs) })
    if (!response.ok) {
      throw new ResidentOperatorError(`registry ${name}@${tag} returned HTTP ${String(response.status)}`, 'RUNTIME_UNAVAILABLE')
    }
    const body: unknown = await response.json()
    const version = recordField(body, 'version')
    const tarball = recordField(recordField(body, 'dist'), 'tarball')
    const integrity = recordField(recordField(body, 'dist'), 'integrity')
    if (typeof version !== 'string' || typeof tarball !== 'string' || typeof integrity !== 'string'
      || !integrity.startsWith('sha512-')) {
      throw new ResidentOperatorError(`registry ${name}@${tag} returned no sha512 package metadata`, 'INVALID_RESULT')
    }
    return { version, tarball, integrity }
  }

  /** Download one verified tarball and unpack it into a fresh staging directory. */
  private async stage(product: ResidentCliProduct, pkg: RegistryVersion): Promise<string> {
    const response = await fetch(pkg.tarball, { signal: AbortSignal.timeout(this.options.downloadTimeoutMs) })
    if (!response.ok) {
      throw new ResidentOperatorError(`download ${pkg.tarball} returned HTTP ${String(response.status)}`, 'RUNTIME_UNAVAILABLE')
    }
    const archive = Buffer.from(await response.arrayBuffer())
    if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== pkg.integrity) {
      throw new ResidentOperatorError(`download ${pkg.tarball} failed its sha512 integrity check`, 'INVALID_RESULT')
    }
    const staging = join(this.options.runtimesRoot, product, `.staging-${randomUUID()}`)
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(join(staging, 'package.tgz'), archive, { mode: 0o600 })
      await run('tar', ['-xzf', join(staging, 'package.tgz'), '-C', staging], this.options.downloadTimeoutMs)
      rmSync(join(staging, 'package.tgz'))
      return staging
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async updateClaude(): Promise<ResidentCliUpdateResult> {
    const product = 'claude-code'
    const version = await this.latest(product)
    const staging = await this.stage(product, await this.registryVersion(this.target().claudePackage, version))
    try {
      const reported = await run(join(staging, 'package', 'claude'), ['--version'], VERSION_TIMEOUT_MS)
      if (reported !== `${version} (Claude Code)` || !claudeCliCompatible(reported)) {
        return {
          product,
          version,
          status: 'incompatible',
          reason: `Claude Code ${reported} is outside the release line this DSH build qualifies`,
        }
      }
      const installed = join(this.options.runtimesRoot, product, version)
      rmSync(installed, { recursive: true, force: true })
      renameSync(staging, installed)
      this.writeWrapper('claude', join(installed, 'package', 'claude'))
      this.pruneVersions(product, version)
      return { product, version, status: 'activated' }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private async updateCodex(): Promise<ResidentCliUpdateResult> {
    const product = 'codex'
    const version = await this.latest(product)
    const target = this.target()
    const staging = await this.stage(product, await this.registryVersion('@openai/codex', `${version}-${target.codexSuffix}`))
    try {
      const packageRoot = join(staging, 'package', 'vendor', target.codexTriple)
      const entrypoint = recordField(JSON.parse(readFileSync(join(packageRoot, 'codex-package.json'), 'utf8')), 'entrypoint')
      const executable = typeof entrypoint === 'string' ? join(packageRoot, entrypoint) : ''
      if (typeof entrypoint !== 'string' || isAbsolute(entrypoint) || relative(packageRoot, executable).startsWith('..')) {
        throw new ResidentOperatorError('Codex package declares no relative entrypoint', 'INVALID_RESULT')
      }
      const reported = await run(executable, ['--version'], VERSION_TIMEOUT_MS)
      const protocol = await codexProtocol(executable)
      if (reported !== `codex-cli ${version}` || protocol.missing.length > 0) {
        return {
          product,
          version,
          status: 'incompatible',
          reason: protocol.missing.length > 0
            ? `Codex ${version} app-server lacks required methods: ${protocol.missing.join(', ')}`
            : `Codex package ${version} reports ${reported}`,
        }
      }
      await run(executable, ['app-server', 'daemon', 'update'], this.options.downloadTimeoutMs)
      let daemon = await codexDaemonVersion(executable)
      if (daemon?.appServerVersion !== version) {
        await run(executable, ['app-server', 'daemon', 'restart'], this.options.downloadTimeoutMs)
        daemon = await codexDaemonVersion(executable)
      }
      if (daemon?.appServerVersion !== version) {
        throw new ResidentOperatorError(
          `Codex app-server daemon reports ${daemon?.appServerVersion ?? 'no version'} after updating to ${version}`,
          'RUNTIME_UNAVAILABLE',
        )
      }
      return { product, version, status: 'activated' }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private writeWrapper(command: string, executable: string): void {
    const bin = managedCliBinDir(this.options.runtimesRoot)
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    const temporary = join(bin, `.${command}.${randomUUID()}.tmp`)
    const quoted = `'${executable.replaceAll('\'', '\'"\'"\'')}'`
    writeFileSync(temporary, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 })
    chmodSync(temporary, 0o700)
    renameSync(temporary, join(bin, command))
  }

  private pruneVersions(product: ResidentCliProduct, keep: string): void {
    const directory = join(this.options.runtimesRoot, product)
    for (const entry of readdirSync(directory)) {
      if (entry !== keep && !entry.startsWith('.staging-')) rmSync(join(directory, entry), { recursive: true, force: true })
    }
  }
}
