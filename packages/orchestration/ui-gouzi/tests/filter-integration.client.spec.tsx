// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as workspaceUi from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as gouzi from '../src/client/index.ts'

afterEach(() => { vi.restoreAllMocks() })

async function boot(order: 'workspace-first' | 'gouzi-first') {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'sidebar.footer.action': { kind: 'list', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  ctx.provide('workspaces', { create: vi.fn(), startSession: vi.fn(), rename: vi.fn(), insertSessionBefore: vi.fn(), list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => undefined } } as never)
  ctx.provide('sessions', { open: vi.fn(), search: vi.fn(), searchResultLimit: 20, binding: vi.fn(), fork: vi.fn(), list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => undefined } } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { request: vi.fn() } as never)
  ctx.provide('conversation', { blocks: { storeFor: () => ({ getSnapshot: () => undefined }) } } as never)
  const loadWorkspace = () => ctx.plugin({ inject: [...workspaceUi.inject], apply: workspaceUi.apply }).await()
  const loadGouzi = () => ctx.plugin({ inject: [...gouzi.inject], apply: gouzi.apply }).await()
  if (order === 'workspace-first') { await loadWorkspace(); await loadGouzi() } else { await loadGouzi(); await loadWorkspace() }
  await new Promise(resolve => setTimeout(resolve, 30))
  const browser = (slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
  return browser.hooks.hiddenSessions
}

describe('the real workspace browser and kennel plugin together', () => {
  for (const order of ['workspace-first', 'gouzi-first'] as const) {
    it(`hides kennel sessions when ${order}`, async () => {
      const source = await boot(order)
      const rule = source.getSnapshot()
      expect(rule, 'a rule is registered').toBeDefined()
      expect(rule!({ agentPreset: 'kennel' } as never)).toBe(true)
      expect(rule!({ agentPreset: 'standard' } as never)).toBe(false)
    })
  }
})
