import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

test('built browser bundle registers an rc.2 module factory and contributes both official slots', async () => {
  let contribution: {
    id: string
    factory: (require: (id: string) => unknown) => {
      name: string
      inject: string[]
      apply: (ctx: unknown) => void
    }
  } | undefined
  const load = vi.fn((value: NonNullable<typeof contribution>) => { contribution = value })
  const source = await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8')
  // Browser scope deliberately has no CommonJS module, exports, or require globals.
  runInNewContext(source, { window: { __ModuleLoader__: { load } } })
  expect(load).toHaveBeenCalledTimes(1)
  expect(contribution?.id).toBe('@lisihao/dsh-solar-chatgpt-web')
  const plugin = contribution!.factory(id => {
    expect(id).toBe('react')
    return require(id)
  })
  expect(plugin.name).toBe('chatgpt-web')
  expect([...plugin.inject]).toEqual(['slots', 'remote', 'connection'])
  const register = vi.fn((_slot: { name: string }, _view: unknown) => () => {})
  const disposeRemote = vi.fn(async () => {})
  const mount = vi.fn(async () => disposeRemote)
  let cleanup: (() => void) | undefined
  plugin.apply({
    effect(callback: () => () => void) { cleanup = callback() },
    remote: { $mount: mount },
    get: () => ({
      status: vi.fn(),
      launch: vi.fn(),
      observe: vi.fn(),
      cancel: vi.fn(),
    }),
    slots: { inject: (_name: string, callback: () => void) => callback(), register },
  })
  await Promise.resolve()
  expect(register.mock.calls.map(call => (call[0] as { name: string }).name)).toEqual(['conversation.view', 'settings.section'])
  expect(mount).toHaveBeenCalledTimes(1)
  cleanup?.()
  await Promise.resolve()
  expect(disposeRemote).toHaveBeenCalledTimes(1)
})
