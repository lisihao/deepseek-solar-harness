import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { HANDOFF_COMPACTION_PREFIX, type ProgressWindow } from '../src/progress.js'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: (next: T) => { value = next; for (const fn of listeners) fn() }, listeners }
}
describe('built browser contribution', () => {
  it('loads through the real module-factory contract and binds the scoped input dock without a Host import', () => {
    let loadedId: string | undefined
    let component!: (props: { sessionId: string }) => unknown
    let slot!: { name: string; id: string }
    let state: unknown
    let effectDeps: readonly unknown[] | undefined
    let cleanup: (() => void) | undefined
    const react = {
      createElement: (type: string, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useState: () => [state, (next: unknown) => { state = next }],
      useLayoutEffect: (effect: () => (() => void) | undefined, deps: readonly unknown[]) => {
        if (!effectDeps || deps.some((value, index) => value !== effectDeps![index])) {
          cleanup?.(); effectDeps = deps; cleanup = effect()
        }
      },
    }
    let exported!: { apply: (ctx: unknown) => void }
    runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: ({ id, factory }: { id: string; factory: Function }) => {
        loadedId = id
        const module = { exports: {} }
        factory((specifier: string) => { expect(specifier).toBe('react'); return react }, module, module.exports)
        exported = module.exports as typeof exported
      } } },
    })
    const source = store<ProgressWindow>({ entries: [], revision: 0, change: { kind: 'replace' } })
    const block = store<{ reason: string } | undefined>(undefined)
    const binding = { eventSource: source }
    let disposed = false
    exported.apply({ effect: (fn: () => unknown) => fn(), sessions: { binding: (id: string) => { expect(id).toBe('a'); return binding } },
      conversation: { blocks: { storeFor: () => block, set: (_id: string, value: { reason: string } | undefined) => block.set(value) } },
      slots: { inject: (name: string, fn: () => unknown) => { expect(name).toBe('conversation.input.dock'); return fn() },
        register: (options: typeof slot, render: typeof component) => { slot = options; component = render; return () => { disposed = true } } },
    })
    expect(loadedId).toBe('@lisihao/dsh-solar-model-handoff')
    expect(slot).toMatchObject({ name: 'conversation.input.dock', id: 'solar-model-handoff-preparation' })
    expect(component({ sessionId: 'a' })).toBeNull()
    const start = { type: 'event', event: { type: 'compaction/start', seq: 1, data: { compactionId: HANDOFF_COMPACTION_PREFIX + 'built' } } }
    source.set({ entries: [start], revision: 1, change: { kind: 'append', entries: [start] } })
    expect(block.getSnapshot()?.reason).toContain('暂不能输入或发送')
    const rendered = component({ sessionId: 'a' })
    expect(JSON.stringify(rendered)).toContain('正在准备上下文')
    expect(JSON.stringify(rendered)).toContain('原草稿会保留')
    const end = { type: 'event', event: { type: 'compaction/end', seq: 2, data: start.event.data } }
    source.set({ entries: [start, end], revision: 2, change: { kind: 'append', entries: [end] } })
    expect(component({ sessionId: 'a' })).toBeNull()
    expect(block.getSnapshot()).toBeUndefined()
    cleanup?.()
    expect(source.listeners.size).toBe(0)
    expect(disposed).toBe(false)
  })
})
