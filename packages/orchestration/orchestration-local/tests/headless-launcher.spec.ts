import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
}))

import { startDetachedOrchestrationDaemon } from '../src/client.ts'

function childProcessStub() {
  return Object.assign(new EventEmitter(), { pid: 4321, unref: vi.fn() })
}

afterEach(() => {
  childProcess.spawn.mockReset()
})

describe('Orchestration daemon headless launcher', () => {
  it('uses the explicit headless executable instead of the Electron application', () => {
    const child = childProcessStub()
    childProcess.spawn.mockReturnValue(child)

    const pid = startDetachedOrchestrationDaemon(
      '/tmp/dsh-orchestration-root',
      '/tmp/dsh-home',
      [],
      [],
      [],
      '/usr/local/bin/node',
    )
    const [executable, args, options] = childProcess.spawn.mock.calls[0] as [
      string,
      readonly string[],
      { readonly env: NodeJS.ProcessEnv },
    ]

    expect(pid).toBe(4321)
    expect(executable).toBe('/usr/local/bin/node')
    expect(args).toContain('--root')
    expect(args).toContain('/tmp/dsh-orchestration-root')
    expect(args).toContain('--dsh-home')
    expect(args).toContain('/tmp/dsh-home')
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects a blank explicit headless executable before spawning', () => {
    expect(() => startDetachedOrchestrationDaemon('/tmp/root', '/tmp/home', [], [], [], '  '))
      .toThrow('headless executable must not be blank')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
