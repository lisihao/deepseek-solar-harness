import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopTerminalStateDirectory,
  openDesktopTerminal,
  type DesktopTerminalOptions,
  type DesktopTerminalSpawn,
} from '../src/desktop-terminal.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-'))
  temporaryDirectories.push(dir)
  return dir
}

interface SpawnHarness {
  child: ChildProcess
  unref: ReturnType<typeof vi.fn>
  emitError: (cause: Error) => void
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void
  spawn: DesktopTerminalSpawn
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>
}

function spawnHarness(): SpawnHarness {
  const calls: SpawnHarness['calls'] = []
  const unref = vi.fn()
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, { unref }) as unknown as ChildProcess
  const spawn: DesktopTerminalSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
  return {
    child,
    unref,
    spawn,
    calls,
    emitError: cause => { emitter.emit('error', cause) },
    emitExit: (code, signal = null) => { emitter.emit('exit', code, signal) },
  }
}

function macOptions(stateDir: string, spawn: DesktopTerminalSpawn): DesktopTerminalOptions {
  return {
    platform: 'darwin',
    appExecutable: "/Applications/DSH O'Brien.app/Contents/MacOS/DSH Desktop",
    dshBootstrapPath: "/Applications/DSH O'Brien.app/Contents/Resources/app.asar/lib/dsh-terminal-bootstrap.js",
    pnpmBinPath: "/Applications/DSH O'Brien.app/Contents/Resources/app.asar/node_modules/pnpm/bin/pnpm.mjs",
    electronVersion: '43.4.0',
    profileName: 'desktop',
    productVersion: '2.0.0',
    profileDir: "/Users/example/Library/Application Support/DSH O'Brien/profiles/desktop",
    homeDir: "/Users/example/Library/Application Support/DSH O'Brien",
    stateDir,
    spawn,
    environment: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      DSH_HOME: '/inherited/dsh-home',
      electron_run_as_node: 'inherited-node-mode',
      KEEP: 'value',
    },
  }
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('desktop terminal environment', () => {
  it('keeps generated shims isolated by active profile', () => {
    const desktop = desktopTerminalStateDirectory('/tmp/dsh-desktop', 'desktop')
    const work = desktopTerminalStateDirectory('/tmp/dsh-desktop', '工作 profile')

    expect(desktop).toMatch(/^\/tmp\/dsh-desktop\/cli\/[a-f0-9]{64}$/u)
    expect(work).toMatch(/^\/tmp\/dsh-desktop\/cli\/[a-f0-9]{64}$/u)
    expect(work).not.toBe(desktop)
    expect(desktopTerminalStateDirectory('/tmp/dsh-desktop', 'desktop')).toBe(desktop)
  })

  it('generates private macOS shims and opens one quoted welcome command', () => {
    const stateDir = join(temporaryDirectory(), 'terminal state')
    const harness = spawnHarness()
    const options = macOptions(stateDir, harness.spawn)

    const launch = openDesktopTerminal(options)

    expect(launch).toMatchObject({
      shimDir: join(stateDir, 'bin'),
      dshShimPath: join(stateDir, 'bin', 'dsh'),
      pnpmShimPath: join(stateDir, 'bin', 'pnpm'),
      nodeShimPath: join(stateDir, 'bin', 'node'),
      welcomePath: join(stateDir, 'welcome.command'),
      child: harness.child,
    })
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700)
    expect(lstatSync(launch.shimDir).mode & 0o777).toBe(0o700)
    for (const filename of [launch.dshShimPath, launch.pnpmShimPath, launch.nodeShimPath, launch.welcomePath]) {
      expect(lstatSync(filename).mode & 0o777).toBe(0o700)
    }

    const dshShim = readFileSync(launch.dshShimPath, 'utf8')
    expect(dshShim).toContain("DSH_DESKTOP_DEFAULT_PROFILE='desktop' ELECTRON_RUN_AS_NODE=1 exec")
    expect(dshShim).toContain('--expose-internals')
    expect(dshShim).toContain("'/Applications/DSH O'\"'\"'Brien.app/Contents/MacOS/DSH Desktop'")
    expect(dshShim).toContain("'/Applications/DSH O'\"'\"'Brien.app/Contents/Resources/app.asar/lib/dsh-terminal-bootstrap.js'")
    expect(dshShim).toContain('"$@"')
    expect(dshShim).not.toContain('npm_config_')
    const pnpmShim = readFileSync(launch.pnpmShimPath, 'utf8')
    expect(pnpmShim).toContain('ELECTRON_RUN_AS_NODE=1 npm_config_runtime=electron')
    expect(pnpmShim).toContain("npm_config_target='43.4.0'")
    expect(pnpmShim).toContain("npm_config_disturl='https://electronjs.org/headers'")
    const nodeShim = readFileSync(launch.nodeShimPath, 'utf8')
    expect(nodeShim).toBe([
      '#!/bin/sh',
      `ELECTRON_RUN_AS_NODE=1 exec '/Applications/DSH O'"'"'Brien.app/Contents/MacOS/DSH Desktop' "$@"`,
      '',
    ].join('\n'))
    expect(nodeShim).not.toContain('npm_config_')

    const welcome = readFileSync(launch.welcomePath, 'utf8')
    expect(welcome).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(welcome).not.toContain('ELECTRON_RUN_AS_NODE=1')
    expect(welcome).toContain("printf '\\033[2J\\033[3J\\033[H'")
    expect(welcome).toContain('DSH Desktop 2.0.0 terminal')
    expect(welcome).toContain('Profile: desktop')
    expect(welcome).toContain('Plugin commands without --profile modify the desktop profile.')
    expect(welcome).toContain('dsh --dump-config')
    expect(welcome).toContain('dsh plugin add <third-party-plugin>')
    expect(welcome).toContain('dsh plugin remove <third-party-plugin>')
    expect(welcome).toContain('dsh plugin update')
    expect(welcome).toContain('Restart DSH Desktop after plugin changes.')
    expect(welcome).not.toContain(' -l')
    expect(welcome).toContain("DSH O'\"'\"'Brien")
    expect(welcome).toContain('exec "${SHELL}" --noprofile --rcfile')
    expect(welcome).toContain('exec "${SHELL}" -i')

    const zshRc = readFileSync(join(stateDir, '.zshrc'), 'utf8')
    expect(zshRc).toContain('source "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc"')
    expect(zshRc).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(zshRc).toContain(`path=('${launch.shimDir}' $path)`)
    const bashRc = readFileSync(join(stateDir, 'bashrc'), 'utf8')
    expect(bashRc).toContain('. "${DSH_DESKTOP_USER_BASHRC}"')
    expect(bashRc.indexOf('. "${DSH_DESKTOP_USER_BASHRC}"')).toBeLessThan(
      bashRc.indexOf(`export PATH='${launch.shimDir}'`),
    )
    if (process.platform === 'darwin') {
      expect(spawnSync('/bin/sh', ['-n', launch.dshShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', launch.pnpmShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', launch.nodeShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', launch.welcomePath]).status).toBe(0)
      expect(spawnSync('/bin/zsh', ['-n', join(stateDir, '.zshrc')]).status).toBe(0)
      expect(spawnSync('/bin/bash', ['-n', join(stateDir, 'bashrc')]).status).toBe(0)
    }

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toEqual({
      command: '/usr/bin/open',
      args: ['-a', 'Terminal', launch.welcomePath],
      options: {
        cwd: options.profileDir,
        detached: true,
        env: {
          KEEP: 'value',
          PATH: `${launch.shimDir}:/usr/local/bin:/usr/bin:/bin`,
          DSH_HOME: options.homeDir,
        },
        shell: false,
        stdio: 'ignore',
      },
    })
    expect(harness.unref).toHaveBeenCalledOnce()
    expect(options.environment).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      DSH_HOME: '/inherited/dsh-home',
      electron_run_as_node: 'inherited-node-mode',
      KEEP: 'value',
    })
  })

  it('accepts localized macOS profile names and rejects path escapes before writing state', () => {
    const root = temporaryDirectory()
    const harness = spawnHarness()
    const unsupported = macOptions(join(root, 'unsupported'), harness.spawn)
    unsupported.platform = 'linux'
    expect(() => openDesktopTerminal(unsupported)).toThrow('terminal is unsupported on linux')
    expect(() => lstatSync(unsupported.stateDir)).toThrow()

    const unsafe = macOptions(join(root, 'unsafe'), harness.spawn)
    unsafe.profileName = '../desktop'
    expect(() => openDesktopTerminal(unsafe)).toThrow('invalid profile name')
    expect(() => lstatSync(unsafe.stateDir)).toThrow()

    const localized = macOptions(join(root, 'localized'), harness.spawn)
    localized.profileName = '工作 profile'
    openDesktopTerminal(localized)
    expect(readFileSync(join(localized.stateDir, 'welcome.command'), 'utf8'))
      .toContain('Profile: 工作 profile')

    const newline = macOptions(join(root, 'newline'), harness.spawn)
    newline.productVersion = '2.0.0\ntouch injected'
    expect(() => openDesktopTerminal(newline)).toThrow('must not contain NUL or newlines')
    expect(() => lstatSync(newline.stateDir)).toThrow()
    expect(harness.calls).toHaveLength(1)
  })
})
