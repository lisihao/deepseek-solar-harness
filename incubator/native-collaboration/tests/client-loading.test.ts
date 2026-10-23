import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

test('built browser bundle registers an rc.2 module factory and contributes the flow view, the composer mode toggle, and the settings section', async () => {
  let contribution: { id: string; factory: (require: (id: string) => unknown) => { name: string; inject: string[]; apply: (ctx: unknown) => void } } | undefined
  const load = vi.fn((value: NonNullable<typeof contribution>) => { contribution = value })
  const source = await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8')
  // Browser scope deliberately has no CommonJS module, exports, or require globals.
  runInNewContext(source, { window: { __ModuleLoader__: { load } } })
  expect(load).toHaveBeenCalledTimes(1)
  expect(contribution?.id).toBe('@lisihao/dsh-solar-native-collaboration')
  const plugin = contribution!.factory(id => {
    expect(['react', 'react/jsx-runtime', 'react-dom']).toContain(id)
    return require(id)
  })
  expect(plugin.name).toBe('native-collaboration')
  expect([...plugin.inject]).toEqual(['slots', 'remote', 'connection'])
  const register = vi.fn((_slot: { name: string }, _view: unknown) => () => {})
  const disposeRemote = vi.fn(async () => {})
  const mount = vi.fn(async () => disposeRemote)
  let cleanup: (() => void) | undefined
  plugin.apply({
    effect(callback: () => () => void) { cleanup = callback() },
    remote: { $mount: mount },
    get: () => ({ status: vi.fn() }),
    slots: { inject: (_name: string, callback: () => void) => callback(), register },
  })
  await Promise.resolve()
  const slots = register.mock.calls.map(call => call[0] as { name: string; id: string; label?: () => string })
  expect(slots.map(slot => slot.name)).toEqual(['conversation.view', 'conversation.input.left', 'settings.section'])
  expect(slots).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'solar-native-collaboration', label: expect.any(Function) }),
    expect.objectContaining({ id: 'solar-session-collaboration-mode' }),
  ]))
  expect(slots.find(slot => slot.id === 'solar-native-collaboration')?.label?.()).toBe('执行流程')
  expect(slots.find(slot => slot.name === 'conversation.input.left')?.label?.()).toBe('智能协同')
  expect(slots.find(slot => slot.name === 'settings.section')?.label?.()).toBe('智能协同')
  expect(mount).toHaveBeenCalledTimes(1)
  cleanup?.()
  await Promise.resolve()
  expect(disposeRemote).toHaveBeenCalledTimes(1)
})
