import { describe, expect, test, vi } from 'vitest'
import {
  LOCAL_AI_ENTRY,
  PI_AI_NAMESPACE,
  apply,
  createLocalAiOperations,
  formFromSnapshot,
  inject,
  resolveTarget,
  type SettingsSnapshot,
} from '../src/client.js'
import { LOCAL_AI_KEY_REF } from '../src/endpoint.js'

const form = (patch: Partial<Parameters<typeof resolveTarget>[0]> = {}) => ({
  mode: 'direct' as const,
  endpoint: 'http://192.168.2.200:8000/v1',
  proxy: 'socks5://127.0.0.1:1055',
  port: '18765',
  displayName: '本地 AI',
  ...patch,
})

describe('form validation', () => {
  test('a direct endpoint becomes the route baseURL and needs no gateway', () => {
    expect(resolveTarget(form({ endpoint: '192.168.2.200:8000/v1/' }))).toEqual({ kind: 'ok', baseURL: 'http://192.168.2.200:8000/v1' })
  })

  test('a Tailscale endpoint routes through the gateway and enables it', () => {
    expect(resolveTarget(form({ mode: 'tailscale', endpoint: 'http://100.114.161.62:8000/v1' }))).toEqual({
      kind: 'ok',
      baseURL: 'http://127.0.0.1:18765/tailnet/100.114.161.62:8000/v1',
      tailscale: { enabled: true, port: 18765, proxy: 'socks5://127.0.0.1:1055' },
    })
  })

  test('each invalid field is named', () => {
    expect(resolveTarget(form({ endpoint: 'ftp://x' }))).toEqual({ kind: 'invalid', reason: 'invalidEndpoint' })
    expect(resolveTarget(form({ mode: 'tailscale' }))).toEqual({ kind: 'invalid', reason: 'tailnetOnly' })
    expect(resolveTarget(form({ mode: 'tailscale', endpoint: '100.114.161.62:8000/v1', proxy: 'http://127.0.0.1:1055' }))).toEqual({ kind: 'invalid', reason: 'invalidProxy' })
    expect(resolveTarget(form({ mode: 'tailscale', endpoint: '100.114.161.62:8000/v1', port: '80' }))).toEqual({ kind: 'invalid', reason: 'invalidPort' })
  })
})

describe('form recovery from stored settings', () => {
  const snapshot = (baseURL: string | undefined): SettingsSnapshot => ({
    writable: true,
    keyConfigured: true,
    piAi: { revision: 3, ...(baseURL === undefined ? {} : { route: { displayName: 'Mini', baseURL, models: [{ id: 'qwen' }], raw: {} } }) },
    self: { revision: 1, tailscale: { enabled: true, port: 19000, proxy: 'socks5://127.0.0.1:2000' } },
  })

  test('a gateway route reopens in Tailscale mode with the original address', () => {
    expect(formFromSnapshot(snapshot('http://127.0.0.1:19000/tailnet/100.114.161.62:8000/v1'), 'Local AI')).toEqual({
      mode: 'tailscale', endpoint: 'http://100.114.161.62:8000/v1', proxy: 'socks5://127.0.0.1:2000', port: '19000', displayName: 'Mini',
    })
  })

  test('a direct route reopens in direct mode; nothing saved falls back to defaults', () => {
    expect(formFromSnapshot(snapshot('http://192.168.2.200:8000/v1'), 'Local AI')).toMatchObject({ mode: 'direct', endpoint: 'http://192.168.2.200:8000/v1' })
    expect(formFromSnapshot(snapshot(undefined), 'Local AI')).toMatchObject({ mode: 'direct', endpoint: '', displayName: 'Local AI' })
  })
})

describe('Remote operations', () => {
  function remote() {
    return {
      settings: {
        describe: vi.fn(async () => ({
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [
              { ns: PI_AI_NAMESPACE, revision: 7, value: {}, user: { providers: { 'local-ai': { displayName: 'Mini', baseURL: 'http://192.168.2.200:8000/v1', headers: { x: '1' }, models: [{ id: 'qwen' }, 'bogus'] }, other: {} } } },
              { ns: LOCAL_AI_ENTRY, revision: 2, value: { tailscale: { enabled: false, port: 18765, proxy: 'socks5://127.0.0.1:1055' } } },
            ],
          },
        })),
        mutate: vi.fn(async (_ns: string, _ops: unknown, revision: number) => revision === 7
          ? { ok: true, value: { revision: 8 } }
          : { ok: false, error: { code: 'settings/conflict', message: 'stale' } }),
      },
      credentials: {
        describe: vi.fn(async () => ({ ok: true, value: { [LOCAL_AI_KEY_REF]: { configured: true, writable: true } } })),
        set: vi.fn(async () => ({ ok: true, value: undefined })),
        unset: vi.fn(async () => ({ ok: false, error: { code: 'credential/rejected', message: 'no' } })),
      },
      llm: {
        discoverModels: vi.fn(async () => ({ ok: true, value: [{ id: 'qwen' }] })),
      },
    }
  }

  test('describe reads only the local-ai route, the gateway settings, and the key state', async () => {
    const fake = remote()
    const snapshot = await createLocalAiOperations(fake as never).describe()
    expect(fake.credentials.describe).toHaveBeenCalledWith([LOCAL_AI_KEY_REF])
    expect(snapshot).toEqual({
      writable: true,
      keyConfigured: true,
      piAi: {
        revision: 7,
        route: {
          displayName: 'Mini',
          baseURL: 'http://192.168.2.200:8000/v1',
          models: [{ id: 'qwen' }],
          raw: { displayName: 'Mini', baseURL: 'http://192.168.2.200:8000/v1', headers: { x: '1' }, models: [{ id: 'qwen' }, 'bogus'] },
        },
      },
      self: { revision: 2, tailscale: { enabled: false, port: 18765, proxy: 'socks5://127.0.0.1:1055' } },
    })
  })

  test('writes report revision, conflict, and refusal outcomes; discovery always names the protocol', async () => {
    const fake = remote()
    const operations = createLocalAiOperations(fake as never)
    expect(await operations.write(PI_AI_NAMESPACE, [], 7)).toEqual({ kind: 'written', revision: 8 })
    expect(await operations.write(PI_AI_NAMESPACE, [], 6)).toEqual({ kind: 'conflict' })
    expect(await operations.removeKey()).toBe('no')
    expect(await operations.storeKey('sk-test')).toBeUndefined()
    expect(fake.credentials.set).toHaveBeenCalledWith(LOCAL_AI_KEY_REF, 'sk-test')
    await operations.discover({ baseURL: 'http://192.168.2.200:8000/v1' })
    expect(fake.llm.discoverModels).toHaveBeenCalledWith(PI_AI_NAMESPACE, { baseURL: 'http://192.168.2.200:8000/v1', api: 'openai-completions' })
  })
})

/** Slot service fake whose inject callbacks run only while their slot is declared. */
function slotFixture() {
  const declared = new Set<string>()
  const injections: { key: string, run: () => () => void, dispose?: () => void }[] = []
  const entries: { name: string, id: string }[] = []
  const effects: (() => void)[] = []
  const slots = {
    inject: (key: string, run: () => () => void) => {
      const injection: { key: string, run: () => () => void, dispose?: () => void } = { key, run }
      injections.push(injection)
      if (declared.has(key)) injection.dispose = run()
      effects.push(() => { injection.dispose?.(); injection.dispose = undefined })
    },
    register: (options: { name: string, id: string }) => {
      const entry = { name: options.name, id: options.id }
      entries.push(entry)
      return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  }
  const ctx = {
    effect: (execute: () => () => void) => { effects.push(execute()) },
    locale: { bind: () => (key: string) => key, register: () => () => undefined },
    slots,
    remote: {},
  }
  return {
    ctx,
    names: () => entries.map(entry => `${entry.name}#${entry.id}`).sort(),
    declare: (key: string) => {
      declared.add(key)
      for (const injection of injections) if (injection.key === key && injection.dispose === undefined) injection.dispose = injection.run()
    },
    undeclare: (key: string) => {
      declared.delete(key)
      for (const injection of injections) if (injection.key === key) { injection.dispose?.(); injection.dispose = undefined }
    },
    dispose: () => { for (const effect of effects.splice(0).reverse()) effect() },
  }
}

describe('Settings registration', () => {
  test('declares every Remote namespace it reads, or Cordis refuses the property at runtime', () => {
    // Observed in a scratch `dsh web` profile: without these entries the page
    // failed with `cannot get property "remote.settings" without inject`.
    expect(inject).toEqual(expect.arrayContaining(['remote', 'remote.settings', 'remote.llm', 'remote.credentials']))
  })

  test('joins the subscription hub when it is present and never shows a second copy', () => {
    const setup = slotFixture()
    setup.declare('settings.section')
    setup.declare('settings.subscriptions.page')
    apply(setup.ctx as never)
    expect(setup.names()).toEqual(['settings.subscriptions.page#local-ai'])
    setup.dispose()
    expect(setup.names()).toEqual([])
  })

  test('falls back to its own Settings section without the hub and moves when the hub loads or unloads', () => {
    const setup = slotFixture()
    setup.declare('settings.section')
    apply(setup.ctx as never)
    expect(setup.names()).toEqual(['settings.section#local-ai'])
    setup.declare('settings.subscriptions.page')
    expect(setup.names()).toEqual(['settings.subscriptions.page#local-ai'])
    setup.undeclare('settings.subscriptions.page')
    expect(setup.names()).toEqual(['settings.section#local-ai'])
    setup.dispose()
    expect(setup.names()).toEqual([])
  })
})
