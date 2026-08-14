// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, SETTINGS_LOCALE_NAMESPACE } from '../src/client/index.ts'
import { alignLoopbackEmbedUrl, WebpageEntry, WebpageModulesSidebar } from '../src/client/RemoteModuleEntry.tsx'
import { createWebpageModulesStore } from '../src/client/store.ts'
import type { WebpageInstanceView } from '../src/contract.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new TestRemote(ctx)
  ctx.provide('connection', {
    isLoopback: true,
    api: {
      settings: {
        describe: vi.fn(() => Promise.resolve({
          rpcId: 'remote-modules-describe' as never,
          result: {
            ok: true as const,
            value: {
              writable: true,
              hasDocument: true,
              namespaces: [{
                ns: 'ui-remote-modules', schema: {}, applies: 'restart' as const,
                value: { instances: [] }, secrets: [], revision: 0,
              }],
            },
          },
        })),
        mutate: vi.fn(),
      },
    },
  } as never)
  await ctx.plugin(SettingsScopeBinder).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declare = () => slots.register({
    name: 'root', children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return { ctx, slots, locale, declare }
}

const instances: WebpageInstanceView[] = [
  { id: 'genesispod', label: 'GenesisPod', targetUrl: 'http://127.0.0.1:13000/', embedUrl: 'http://localhost:3000/', order: 100 },
  { id: 'thunder-omlx', label: 'ThunderOMLX', targetUrl: 'http://127.0.0.1:18002/admin/', embedUrl: 'http://localhost:18102/', order: 200 },
]

function storeProps(): PropsStore<ReturnType<typeof createWebpageModulesStore>> {
  const instance = createWebpageModulesStore().create()
  instance.actions.begin(1)
  instance.actions.succeed(1, instances)
  return { useStore: bindSnapshotSelector(instance.store), actions: instance.actions }
}

describe('Web page browser plugin', () => {
  it('registers one vertical multi-instance container and removes it with its fiber', async () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
    const b = await bench()
    b.declare()
    vi.stubGlobal('fetch', vi.fn())
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entries = b.slots.entries('sidebar.footer.action')
    expect(entries.map(entry => [entry.options.id, entry.options.order])).toEqual([['remote-webpages', 100]])
    expect(entries[0]!.store).toBeTruthy()
    const face = (entries[0]!.inject as (actions: unknown) => { load: unknown })(null)
    expect(typeof face.load).toBe('function')
    const settingsTab = b.slots.entries('settings.plugins.tab')[0]!
    expect(settingsTab.options).toMatchObject({ id: 'remote-modules', order: 10 })
    expect(settingsTab.locale).toBe(SETTINGS_LOCALE_NAMESPACE)
    expect(resolveSlotLabel(settingsTab.options.label)).toBe('远程模块')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(settingsTab.options.label)).toBe('Remote Modules')
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('loads and validates the Host-published instance roster through the controller', async () => {
    const b = await bench()
    b.declare()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ instances }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('sidebar.footer.action')[0]!
    const instance = (entry.store as ReturnType<typeof createWebpageModulesStore>).create()
    const injected = (entry.inject as (actions: typeof instance.actions) => { load: () => Promise<void> })(instance.actions)
    await injected.load()
    expect(fetchMock).toHaveBeenCalledWith('/remote-webpages/v1/instances', expect.any(Object))
    expect(instance.store.getSnapshot()).toMatchObject({ phase: 'ready', instances })
  })
})

describe('Web page instance UI', () => {
  it('keeps relay cookies same-site when Harness uses an IPv4 loopback address', () => {
    expect(alignLoopbackEmbedUrl('http://localhost:18102/admin/', '127.0.0.1'))
      .toBe('http://127.0.0.1:18102/admin/')
    expect(alignLoopbackEmbedUrl('http://localhost:18102/admin/', 'localhost'))
      .toBe('http://localhost:18102/admin/')
    expect(alignLoopbackEmbedUrl('https://example.com/admin/', '127.0.0.1'))
      .toBe('https://example.com/admin/')
  })

  it('renders every configured instance as a vertical sidebar row', async () => {
    render(<WebpageModulesSidebar
      useSessions={vi.fn()} useWorkspaces={vi.fn()} wide
      {...storeProps()} load={vi.fn(async () => {})}
    />)
    const stack = screen.getByTestId('remote-webpages-sidebar-stack')
    expect(stack.className).toContain('entryStack')
    expect(stack.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'GenesisPod' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ThunderOMLX' })).toBeTruthy()
  })

  it('opens the actual configured page in an iframe, reloads it, and closes by Escape', async () => {
    render(<WebpageEntry useSessions={vi.fn()} useWorkspaces={vi.fn()} wide {...instances[0]!} />)
    fireEvent.click(screen.getByRole('button', { name: 'GenesisPod' }))
    const frame = screen.getByTitle('GenesisPod 网页') as HTMLIFrameElement
    expect(frame.src).toBe('http://localhost:3000/')
    expect(screen.queryByText('服务状态')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载 GenesisPod' }))
    await waitFor(() => { expect(screen.getByTitle('GenesisPod 网页')).not.toBe(frame) })
    expect(screen.getByRole('link', { name: '在新窗口打开 GenesisPod' }).getAttribute('href')).toBe('http://localhost:3000/')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'GenesisPod' })).toBeNull()
  })
})
