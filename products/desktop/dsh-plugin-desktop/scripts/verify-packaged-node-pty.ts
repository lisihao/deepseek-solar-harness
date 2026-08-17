/** Execute node-pty from the finished macOS application bundle. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE_MARKER = 'DSH_PACKAGED_NODE_PTY_OK'

/** Minimal child-process result consumed by the verifier. */
export interface NodePtyProbeResult {
  readonly error?: Error
  readonly status: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/** Injectable verification boundary for focused tests. */
export interface PackagedNodePtyOptions {
  /** Desktop package root containing dist/. */
  readonly desktopRoot: string
  /** Architecture selected by Electron Builder. */
  readonly arch: string
  /** Host platform running the verification. */
  readonly platform: NodeJS.Platform
  /** Environment inherited by the packaged Electron probe. */
  readonly env: NodeJS.ProcessEnv
  /** Physical-file probe. */
  readonly exists: (filename: string) => boolean
  /** Execute the packaged Electron binary. */
  readonly run: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => NodePtyProbeResult
}

/** Resolve the directory name Electron Builder uses for an unpacked macOS app. */
export function macOutputDirectory(arch: string): string {
  if (arch === 'arm64') return 'mac-arm64'
  if (arch === 'x64') return 'mac'
  if (arch === 'universal') return 'mac-universal'
  throw new Error(`verify-packaged-node-pty: unsupported macOS architecture ${JSON.stringify(arch)}`)
}

function defaultOptions(): PackagedNodePtyOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    desktopRoot,
    arch: process.arch,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    run: (executable, args, env) => {
      const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        env,
        timeout: 15_000,
      })
      return {
        ...result.error === undefined ? {} : { error: result.error },
        status: result.status,
        signal: result.signal,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },
  }
}

/**
 * Run the exact native PTY path shipped to users. This catches ASAR helper-path
 * regressions that static existence checks cannot detect.
 */
export function verifyPackagedNodePty(options: PackagedNodePtyOptions = defaultOptions()): void {
  if (options.platform !== 'darwin') {
    throw new Error('verify-packaged-node-pty: the packaged PTY probe requires macOS')
  }
  const appRoot = join(
    options.desktopRoot,
    'dist',
    macOutputDirectory(options.arch),
    'DSH Desktop.app',
  )
  const executable = join(appRoot, 'Contents', 'MacOS', 'DSH Desktop')
  const unpackedRoot = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
  const nodePtyRoot = join(unpackedRoot, 'node_modules', 'node-pty')
  for (const required of [
    executable,
    join(nodePtyRoot, 'lib', 'index.js'),
    join(nodePtyRoot, 'build', 'Release', 'pty.node'),
    join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (!options.exists(required)) {
      throw new Error(`verify-packaged-node-pty: packaged application is missing ${required}`)
    }
  }

  const probe = String.raw`
const path = require('node:path')
const nodePty = require(path.join(process.argv[1], 'node_modules', 'node-pty'))
const expected = 'dsh-pty-probe-output'
let output = ''
const timer = setTimeout(() => {
  process.stderr.write('node-pty probe timed out\n')
  process.exit(3)
}, 5000)
try {
  const terminal = nodePty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf ' + expected], {
    name: 'dumb',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: process.env,
  })
  terminal.onData(chunk => { output += chunk })
  terminal.onExit(event => {
    setTimeout(() => {
      clearTimeout(timer)
      if (event.exitCode !== 0 || output !== expected) {
        process.stderr.write('unexpected PTY result: ' + JSON.stringify({ event, output }) + '\n')
        process.exit(4)
      }
      process.stdout.write('${PROBE_MARKER}\n')
    }, 25)
  })
} catch (error) {
  clearTimeout(timer)
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.exit(2)
}
`
  const result = options.run(executable, ['-e', probe, unpackedRoot], {
    ...options.env,
    ELECTRON_RUN_AS_NODE: '1',
  })
  if (result.error !== undefined) {
    throw new Error('verify-packaged-node-pty: failed to start packaged Electron', {
      cause: result.error,
    })
  }
  if (result.status !== 0 || !result.stdout.includes(PROBE_MARKER)) {
    const detail = [
      `status=${String(result.status)}`,
      `signal=${String(result.signal ?? 'none')}`,
      `stdout=${JSON.stringify(result.stdout)}`,
      `stderr=${JSON.stringify(result.stderr)}`,
    ].join(' ')
    throw new Error(`verify-packaged-node-pty: packaged PTY execution failed: ${detail}`)
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    verifyPackagedNodePty()
    console.log(PROBE_MARKER)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
