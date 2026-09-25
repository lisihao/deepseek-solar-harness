import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
}))
import { residentDaemonEnvironment, startDetachedResidentDaemon } from '../src/client.ts'
import { clearElectronRunAsNode } from '../src/startup.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  childProcess.spawn.mockReset()
})

function childProcessStub() {
  return Object.assign(new EventEmitter(), { pid: 1234, unref: vi.fn() })
}
describe('Resident daemon Electron bootstrap', () => {
  it('adds RunAsNode only to the Electron child environment', () => {
    const host = { PATH: '/usr/bin', electron_run_as_node: 'stale' }
    const child = residentDaemonEnvironment(host, '43.4.0')

    expect(host).toEqual({ PATH: '/usr/bin', electron_run_as_node: 'stale' })
    expect(child).toEqual({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
  })

  it('removes inherited RunAsNode in ordinary Node and daemon product environments', () => {
    const child = residentDaemonEnvironment({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }, undefined)
    expect(child).toEqual({ PATH: '/bin' })

    const daemon = { Electron_Run_As_Node: '1', PATH: '/usr/bin' }
    clearElectronRunAsNode(daemon)
    expect(daemon).toEqual({ PATH: '/usr/bin' })
  })
})

describe('Resident daemon headless launcher', () => {
  it('uses the explicit headless executable instead of the Electron application', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-launcher-'))
    roots.push(root)
    const child = childProcessStub()
    childProcess.spawn.mockReturnValue(child)

    const pid = startDetachedResidentDaemon(root, [], '/opt/homebrew/bin/node')
    const [executable, args, options] = childProcess.spawn.mock.calls[0] as [
      string,
      readonly string[],
      { readonly env: NodeJS.ProcessEnv },
    ]

    expect(pid).toBe(1234)
    expect(executable).toBe('/opt/homebrew/bin/node')
    expect(args).toContain('--root')
    expect(args).toContain(root)
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects a blank explicit headless executable before spawning', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-launcher-'))
    roots.push(root)

    expect(() => startDetachedResidentDaemon(root, [], '  ')).toThrow('headless executable must not be blank')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
