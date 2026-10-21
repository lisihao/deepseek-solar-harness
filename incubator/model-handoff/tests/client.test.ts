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
    const states: unknown[] = []
    let stateIndex = 0
    let effectDeps: readonly unknown[] | undefined
    let cleanup: (() => void) | undefined
    const react = {
      createElement: (type: string, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useState: (initial?: unknown) => {
        const index = stateIndex++
        return [states[index] ?? initial, (next: unknown) => {
          states[index] = typeof next === 'function' ? next(states[index] ?? initial) : next
        }]
      },
      useLayoutEffect: (effect: () => (() => void) | undefined, deps: readonly unknown[]) => {
        if (!effectDeps || deps.some((value, index) => value !== effectDeps![index])) {
          cleanup?.(); effectDeps = deps; cleanup = effect()
        }
      },
    }
    let exported!: { apply: (ctx: unknown) => void; inject: readonly string[] }
    runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: ({ id, factory }: { id: string; factory: Function }) => {
        loadedId = id
        exported = factory((specifier: string) => { expect(specifier).toBe('react'); return react }) as typeof exported
      } } },
    })
    expect(exported.inject).toEqual(['sessions', 'conversation', 'slots'])
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
    const render = () => { stateIndex = 0; return component({ sessionId: 'a' }) }
    expect(render()).toBeNull()
    const start = { type: 'event', event: { type: 'compaction/start', seq: 1, data: { compactionId: HANDOFF_COMPACTION_PREFIX + 'built' } } }
    source.set({ entries: [start], revision: 1, change: { kind: 'append', entries: [start] } })
    expect(block.getSnapshot()?.reason).toContain('暂不能输入或发送')
    const rendered = render() as any
    expect(JSON.stringify(rendered)).toContain('正在准备上下文')
    expect(JSON.stringify(rendered)).toContain('原草稿会保留')
    expect(rendered.props.style).toMatchObject({ display: 'flex', justifyContent: 'center', width: '100%' })
    const closeButton = rendered.children[0].children[0].children[1]
    expect(closeButton.props['aria-label']).toBe('关闭交接状态提示')
    closeButton.props.onClick()
    expect(render()).toBeNull()
    expect(block.getSnapshot()?.reason).toContain('暂不能输入或发送')
    const failed = { type: 'event', event: { type: 'compaction/end', seq: 2, data: { ...start.event.data, error: 'fixture failure' } } }
    source.set({ entries: [start, failed], revision: 2, change: { kind: 'append', entries: [failed] } })
    const failedNotice = render() as any
    expect(JSON.stringify(failedNotice)).toContain('模型交接未完成')
    failedNotice.children[0].children[0].children[1].props.onClick()
    expect(render()).toBeNull()
    source.set({ entries: [start, failed], revision: 3, change: { kind: 'replace' } })
    expect(render()).toBeNull()
    const nextStart = { ...start, event: { ...start.event, seq: 3, data: { compactionId: HANDOFF_COMPACTION_PREFIX + 'next' } } }
    source.set({ entries: [start, failed, nextStart], revision: 4, change: { kind: 'append', entries: [nextStart] } })
    expect(JSON.stringify(render())).toContain('正在准备上下文')
    const end = { type: 'event', event: { type: 'compaction/end', seq: 4, data: nextStart.event.data } }
    source.set({ entries: [start, failed, nextStart, end], revision: 5, change: { kind: 'append', entries: [end] } })
    expect(render()).toBeNull()
    expect(block.getSnapshot()).toBeUndefined()
    cleanup?.()
    expect(source.listeners.size).toBe(0)
    expect(disposed).toBe(false)
  })
})
