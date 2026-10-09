// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, EMPTY_CHAT_SNAPSHOT, type ConversationSnapshot, type ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { KennelRoomAside, KennelRoomComposer, KennelRoomContent, KennelRoomHeader, type KennelRoomProps, type KennelRoomComposerProps } from '../src/client/KennelRoom.tsx'
import { createKennelRoomStore } from '../src/client/room-store.ts'
import { KennelRoomSource, type KennelRoomReadState } from '../src/client/room-source.ts'
import { loadKennelRoom, readKennelEvidence } from '../src/client/room-api.ts'
import type { BrowserRequest } from '../src/client/api.ts'
import { encodeKennelMessage, type KennelRecipient } from '../src/recipient-message.ts'
import type { GouziRoomSnapshotV1 } from '../src/contracts.ts'
afterEach(() => { cleanup(); vi.useRealTimers() })
function room(): GouziRoomSnapshotV1 {
  return { version: 1, sessionId: 's', roomPollIntervalMs: 2_000, generatedAt: 'now', dashboard: { version: 1, generatedAt: 'now', limit: 10, used: 2, canManage: true, hostAvailable: true, hosts: [], members: ['g1', 'g2'].map((gouziId, i) => ({ gouziId, name: '同名', avatarId: 'shiba', role: 'development', hostId: `h${i}`, hostLabel: `机器${i}`, membership: 'enabled', connection: 'online', activity: 'resting', state: 'resting', createdAt: 'now' })) }, execution: ['g1', 'g2'].map(gouziId => ({ gouziId, generation: 1, projectScopes: ['/project'], operators: [{ operatorId: `${gouziId}.real`, available: true, supportsGenerationLimits: true, models: [] }] })), tasks: [] }
}
function harness() {
  const state = createSnapshotStore<KennelRoomReadState>({ room: room(), loading: false, stale: false, error: null })
  const store = createKennelRoomStore().create('s')
  const session = createSnapshotStore({
    nodes: [], partial: null, removed: false, chat: EMPTY_CHAT_SNAPSHOT, queue: [], hasMore: false, loadingOlder: false,
  } as unknown as ConversationSnapshot)
  const send = vi.fn(async (_message: { text: string; recipient: KennelRecipient | null }) => {})
  const readEvidence = vi.fn(async (_runId: string, _ref: string) => ({ actual: true }))
  const loadOlder = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  const props = { useRoom: bindSnapshotSelector(state), useStore: bindSnapshotSelector(store), actions: store.actions, useSession: bindSnapshotSelector(session), useSessions: bindSnapshotSelector(createSnapshotStore({ byId: { s: { cwd: '/work/room' } } })), useWorkspaces: bindSnapshotSelector(createSnapshotStore({ items: [{ title: '项目', sessionIds: ['s'] }] })), sessionId: 's', inert: false, blocked: undefined, send, readEvidence, loadOlder, reload } as unknown as KennelRoomProps & KennelRoomComposerProps
  return { state, store, session, send, readEvidence, loadOlder, reload, props }
}
function patchRoom(h: ReturnType<typeof harness>, edit: (current: GouziRoomSnapshotV1) => GouziRoomSnapshotV1): void {
  const state = h.state.getSnapshot()
  if (!state.room) throw new Error('Expected room fixture')
  h.state.set({ ...state, room: edit(state.room) })
}
function all(h: ReturnType<typeof harness>) {
  return render(<>
    <KennelRoomHeader {...h.props} /><KennelRoomContent {...h.props} />
    <KennelRoomComposer {...h.props} /><KennelRoomAside {...h.props} />
  </>)
}
function point(index = 0) { fireEvent.click(screen.getAllByRole('button', { name: /^发给 同名 · 机器/ })[index]!) }
function draft(text = '任务正文') { fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: text } }) }
function sendButton() { return screen.getByRole('button', { name: '发送' }) }
describe('kennel room interaction', () => {
  it('selects the clicked member with its real generation while viewing messages only changes the filter', () => {
    const h = harness()
    patchRoom(h, current => ({ ...current, execution: current.execution.map(e => e.gouziId === 'g1' ? { ...e, generation: 7 } : e) }))
    const { container } = all(h)
    expect(screen.getByText('自动分派')).toBeTruthy()
    fireEvent.click(screen.getAllByText('同名')[0]!)
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'all', recipient: { gouziId: 'g1', generation: 7, mode: 'standard' } })
    expect(screen.getByText('发给 同名')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器1 · 开发 的消息' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'g2', recipient: { gouziId: 'g1', generation: 7, mode: 'standard' } })
    fireEvent.click(screen.getByRole('button', { name: '清除点名' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'g2', recipient: null })
    expect(screen.getByText('自动分派')).toBeTruthy()
    expect(container.textContent).not.toContain('标准任务')
    expect(h.send).not.toHaveBeenCalled()
  })
  it('keeps message filtering available when the member cannot be selected for execution', () => {
    const h = harness()
    patchRoom(h, current => ({ ...current, execution: current.execution.map(e => ({
      ...e, operators: e.operators.map(o => ({ ...o, available: false })),
    })) }))
    all(h)
    const member = screen.getByRole('button', { name: '发给 同名 · 机器0 · 开发' })
    expect(member).toHaveProperty('disabled', true)
    fireEvent.click(member)
    expect(h.store.getSnapshot().recipient).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'g1', recipient: null })
  })
  it('explains unconfirmed project scopes and prevents targeting an otherwise available operator', () => {
    const h = harness()
    patchRoom(h, current => ({ ...current, execution: current.execution.map(e => ({ ...e, projectScopes: [] })) }))
    all(h)
    expect(screen.getAllByText('项目尚未确认，暂不能向该成员发送。')).toHaveLength(2)
    const member = screen.getByRole('button', { name: '发给 同名 · 机器0 · 开发' })
    expect(member).toHaveProperty('disabled', true)
    fireEvent.click(member)
    expect(h.store.getSnapshot().recipient).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'g1', recipient: null })
    expect(h.send).not.toHaveBeenCalled()
  })
  it.each([false, undefined])('requires an available entry that explicitly supports execution limits (%s)', (supportsGenerationLimits) => {
    const h = harness()
    patchRoom(h, current => ({ ...current, execution: current.execution.map(e => ({ ...e, operators: [
      {
        operatorId: e.operators[0]!.operatorId, models: e.operators[0]!.models, available: true,
        ...supportsGenerationLimits === undefined ? {} : { supportsGenerationLimits },
      },
      { ...e.operators[0]!, operatorId: 'unavailable-capable', available: false, supportsGenerationLimits: true },
    ] })) }))
    all(h)
    expect(screen.getAllByText('当前执行入口不支持聊天任务所需的执行限制，暂不能点名发送。')).toHaveLength(2)
    const member = screen.getByRole('button', { name: '发给 同名 · 机器0 · 开发' })
    expect(member).toHaveProperty('disabled', true)
    fireEvent.click(member)
    expect(h.store.getSnapshot().recipient).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(h.store.getSnapshot().filter).toBe('g1')
    expect(h.send).not.toHaveBeenCalled()
  })
  it('hides internal context and diagnostic events while retaining chat, terminal failures and sealed task results', () => {
    const h = harness()
    h.session.update((d) => {
      d.nodes = [
        { kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: '请检查任务' }], source: null },
        { kind: 'context', seq: 121, time: 2, content: [{ type: 'text', text: '内部模型上下文' }], source: null, provenance: { role: 'inject', label: null }, form: null },
        { kind: 'unknown', seq: 122, time: 3, type: 'system/diagnostic', data: '内部诊断' },
        { kind: 'assistant', seq: 123, time: 4, turn: 1, step: 1, blocks: [{ kind: 'text', text: '总管回复' }] },
        { kind: 'turn-error', seq: 132, time: 5, turn: 1, step: 1, message: '执行入口拒绝当前仓库', code: 'REPOSITORY_DENIED' },
      ]
    })
    patchRoom(h, current => ({ ...current, tasks: [{ runId: 'run', title: '已封存任务', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [{ nodeId: 'n', title: '执行节点', state: 'passed', attempt: 1, capabilityGeneration: 1, gouziId: 'g1', evidenceRefs: ['ref'], result: { sequence: 7, time: '2026-10-06T00:00:00.000Z', evidenceRef: 'ref', outputPreview: '狗子封存输出', accepted: true, operatorId: 'g1.real' } }] }] }))
    const { container } = all(h)
    expect(screen.getByText('请检查任务')).toBeTruthy()
    expect(screen.getByText('总管回复')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('执行入口拒绝当前仓库（REPOSITORY_DENIED）')
    expect(screen.getByText('狗子封存输出')).toBeTruthy()
    expect(screen.getAllByText('执行结束 · 结果已接纳')).toHaveLength(1)
    expect(screen.getAllByText('结果已接纳')).toHaveLength(1)
    expect(screen.queryByText(/验收通过/)).toBe(null)
    expect(container.textContent).not.toContain('内部模型上下文')
    expect(container.textContent).not.toContain('内部诊断')
    expect(container.textContent).not.toContain('序号')
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(screen.getByRole('alert').textContent).toBe('执行入口拒绝当前仓库（REPOSITORY_DENIED）')
    expect(screen.queryByText('总管回复')).toBe(null)
    expect(screen.getByText('狗子封存输出')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '总管' }))
    expect(screen.getByRole('alert').textContent).toContain('执行入口拒绝当前仓库')
    expect(screen.queryByText('狗子封存输出')).toBe(null)
  })
  it('shows the actual terminal failure even when it has no code', () => {
    const h = harness()
    h.session.update((d) => { d.nodes = [{ kind: 'turn-error', seq: 132, time: 1, turn: 1, step: 1, message: '连接已关闭，任务未完成' }] })
    all(h)
    expect(screen.getByRole('alert').textContent).toBe('连接已关闭，任务未完成')
    expect(screen.queryByText(/序号/)).toBe(null)
  })
  it('renders actual tool activity once and hides raw chat diagnostics', () => {
    const h = harness()
    const result: ToolResultNode = { kind: 'tool-result', seq: 7, time: 7, callId: 'call', call: { name: 'read', argsRaw: '{}' }, callTime: 2, content: [{ type: 'text', text: '真实工具结果' }], isError: false, callView: null, resultView: null, subCalls: [] }
    const tool: ChatNode<'tool-call'> = { target: 'chat', key: 'tool:call', kind: 'tool-call', id: 'call', anchorSeq: 2, location: { kind: 'unresolved' }, visibility: 'visible', data: { root: result } }
    const diagnostic = { target: 'chat' as const, key: 'raw', kind: 'raw-event', id: 'raw', anchorSeq: 3, location: { kind: 'unresolved' as const }, visibility: 'visible' as const, data: '内部事件' }
    h.session.update((d) => {
      d.nodes = [result]
      d.chat = {
        ...EMPTY_CHAT_SNAPSHOT, order: [tool.key, diagnostic.key], nodes: {
          get: key => key === tool.key ? tool : key === diagnostic.key ? diagnostic : undefined,
          values: () => [tool, diagnostic],
        },
      }
    })
    const { container } = all(h)
    expect(screen.getByText('工具 · read')).toBeTruthy()
    expect(screen.getAllByText('真实工具结果')).toHaveLength(1)
    expect(container.textContent).not.toContain('raw-event')
    expect(container.textContent).not.toContain('序号')
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(screen.queryByText('真实工具结果')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '总管' }))
    expect(screen.getByText('真实工具结果')).toBeTruthy()
  })
  it('keeps two members visible and filters independently from stable recipient identity', () => {
    const h = harness(); all(h)
    expect(screen.getByRole('heading', { name: '狗窝' })).toBeTruthy()
    expect(screen.getByText('项目')).toBeTruthy()
    point(); fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器1 · 开发 的消息' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'g2', recipient: { gouziId: 'g1', generation: 1 } })
    expect(screen.getAllByRole('button', { name: /^发给 同名 · 机器/ })).toHaveLength(2)
    act(() => { patchRoom(h, current => ({ ...current, dashboard: { ...current.dashboard, members: current.dashboard.members.map(m => m.gouziId === 'g1' ? { ...m, name: '改名' } : m) } })) })
    expect(screen.getByText('发给 改名')).toBeTruthy()
  })
  it.each(['disabled', 'generation', 'stale', 'unavailable', 'projectScopes', 'generationLimits'])('retains and blocks the confirmed target after %s', (change) => {
    const h = harness(); all(h); point(); draft()
    act(() => {
      if (change === 'stale') h.state.set({ ...h.state.getSnapshot(), stale: true, error: 'network lost' })
      else patchRoom(h, current => ({
        ...current,
        dashboard: change === 'disabled'
          ? { ...current.dashboard, members: current.dashboard.members.map(m => ({ ...m, membership: 'archived' })) }
          : current.dashboard,
        execution: current.execution.map(e => ({
          ...e, generation: change === 'generation' ? 2 : e.generation,
          projectScopes: change === 'projectScopes' ? [] : e.projectScopes,
          operators: e.operators.map(o => ({ ...o, available: change === 'unavailable' ? false : o.available, ...change === 'generationLimits' ? { supportsGenerationLimits: false } : {} })),
        })),
      }))
    })
    expect(sendButton()).toHaveProperty('disabled', true)
    expect(h.store.getSnapshot().recipient?.gouziId).toBe('g1')
    fireEvent.click(sendButton()); expect(h.send).not.toHaveBeenCalled()
    if (change === 'stale') expect(screen.getByRole('alert').textContent).toContain('network lost')
    if (change === 'projectScopes') expect(screen.getByRole('status').textContent).toBe('原发送对象的项目尚未确认；目标已保留，暂不能发送。')
    if (change === 'generationLimits') expect(screen.getByRole('status').textContent).toBe('原发送对象的执行入口不支持聊天任务所需的执行限制；目标已保留，暂不能发送。')
  })
  it('clears the accepted draft and exposes hidden-send notice without changing target', async () => {
    const h = harness(); all(h); point(); fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器1 · 开发 的消息' })); draft()
    fireEvent.click(sendButton())
    await waitFor(() => { expect(h.store.getSnapshot().draft).toBe('') })
    expect(h.send).toHaveBeenCalledWith({ text: '任务正文', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    expect(screen.getByText(/被当前筛选隐藏/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('消息已提交 · 发给 同名')
    expect(screen.queryByText(/已发送到/)).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }))
    expect(h.store.getSnapshot()).toMatchObject({ filter: 'all', recipient: { gouziId: 'g1' } })
  })
  it('reports accepted automatic dispatch submission without claiming running execution', async () => {
    const h = harness(); all(h); draft(); fireEvent.click(sendButton())
    await waitFor(() => { expect(h.store.getSnapshot().draft).toBe('') })
    expect(screen.getByRole('status').textContent).toBe('消息已提交 · 自动分派')
    expect(screen.queryByText(/正在自动分派|正在安排给/)).toBe(null)
    expect(screen.queryByText(/已提交给总管。暂无可见日志记录/)).toBe(null)
    expect(screen.queryByText(/执行结束/)).toBe(null)
  })
  it('preserves failed draft and displays the actual error without retry', async () => {
    const h = harness(); h.send.mockRejectedValue(new Error('receipt refused')); all(h); draft('@同名 正文'); fireEvent.click(sendButton())
    await screen.findByText('发送失败：receipt refused')
    expect(h.store.getSnapshot().draft).toBe('@同名 正文')
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.send).toHaveBeenCalledWith({ text: '@同名 正文', recipient: null })
    expect(screen.getByText(/手写 @名字/)).toBeTruthy()
  })
  it('renders durable recipient history and distinguishes unknown tasks from sealed results', async () => {
    const h = harness()
    h.session.update((d) => { d.nodes = [{ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: encodeKennelMessage('历史正文', { gouziId: 'g1', generation: 1, mode: 'standard' }) }], source: null }] })
    patchRoom(h, current => ({ ...current, tasks: [{ runId: 'run', title: '真实任务', state: 'indeterminate', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [{ nodeId: 'n', title: '真实节点', state: 'indeterminate', attempt: 1, capabilityGeneration: 1, evidenceRefs: [] }] }] }))
    all(h)
    expect(screen.getByText('历史正文')).toBeTruthy()
    expect(screen.getByText('发给 同名')).toBeTruthy()
    expect(screen.getByText(/需核对原执行/)).toBeTruthy()
    expect(h.send).not.toHaveBeenCalled()
    act(() => {
      patchRoom(h, current => ({ ...current, tasks: current.tasks.map(t => ({
        ...t, nodes: t.nodes.map(n => ({ ...n, gouziId: 'g1', result: {
          sequence: 7, time: '2026-10-06T00:00:00.000Z', evidenceRef: 'ref',
          outputPreview: '真实输出', accepted: false, operatorId: 'g1.real',
        } })),
      })) }))
    })
    fireEvent.click(screen.getByRole('button', { name: '查看证据' }))
    await screen.findByText(/"actual": true/)
    fireEvent.click(screen.getByRole('button', { name: '总管' }))
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByRole('button', { name: '收起证据' })).toBeTruthy()
    expect(h.readEvidence).toHaveBeenCalledExactlyOnceWith('run', 'ref')
    expect(screen.getAllByText('执行结束 · 结果未接纳')).toHaveLength(1)
    expect(screen.getAllByText('结果未接纳')).toHaveLength(1)
  })
  it('shows addressed user messages under the matching recipient filter', () => {
    const h = harness()
    h.session.update((d) => {
      d.nodes = [{ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: encodeKennelMessage('定向历史', { gouziId: 'g1', generation: 1, mode: 'standard' }) }], source: null }]
    })
    all(h)
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器0 · 开发 的消息' }))
    expect(screen.getByText('定向历史')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '总管' }))
    expect(screen.queryByText('定向历史')).toBe(null)
  })
  it('uses execution registration independently from connection reachability', () => {
    const h = harness()
    patchRoom(h, current => ({ ...current, dashboard: { ...current.dashboard, members: current.dashboard.members.map(m => ({ ...m, connection: 'unreachable' })) } }))
    all(h); point(); draft()
    expect(sendButton()).toHaveProperty('disabled', false)
    expect(screen.getAllByText(/联系不上 · 执行入口可用/)).toHaveLength(2)
    expect(screen.queryByText('g1')).toBe(null)
  })
  it('loads earlier framework history and preserves the visible message anchor', async () => {
    const h = harness()
    const original = { kind: 'user', seq: 2, time: 2, content: [{ type: 'text', text: '当前记录' }], source: null } as const
    h.session.update((d) => { d.hasMore = true; d.nodes = [original] })
    all(h)
    const log = screen.getByRole('log')
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    log.scrollTop = 100; fireEvent.scroll(log)
    const current = screen.getByText('当前记录').closest('article')!
    let offset = 100
    vi.spyOn(current, 'getBoundingClientRect').mockImplementation(() => ({ top: offset, bottom: offset + 20 }) as DOMRect)
    h.loadOlder.mockImplementation(async () => {
      offset = 300
      h.session.update((d) => { d.nodes = [{ ...original, seq: 1, content: [{ type: 'text', text: '更早记录' }] }, original]; d.hasMore = false })
    })
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }))
    await screen.findByText('更早记录')
    expect(h.loadOlder).toHaveBeenCalledOnce()
    expect(log.scrollTop).toBe(300)
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBe(null)
  })
  it('surfaces actual history failure and reflects framework loading state', async () => {
    const h = harness(); h.session.update((d) => { d.hasMore = true; d.loadingOlder = true }); all(h)
    expect(screen.getByRole('button', { name: '加载中…' })).toHaveProperty('disabled', true)
    act(() => { h.session.update((d) => { d.loadingOlder = false }) })
    h.loadOlder.mockRejectedValue(new Error('history unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }))
    await screen.findByText('历史读取失败：history unavailable')
    expect(h.loadOlder).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '加载更早记录' })).toHaveProperty('disabled', false)
  })
  it('shows only authoritative queue messages and removes them on durable admission', async () => {
    const h = harness()
    const text = encodeKennelMessage('排队正文', { gouziId: 'g1', generation: 1, mode: 'standard' })
    h.send.mockImplementation(async () => {
      h.session.update((d) => { d.queue = [{ id: 'q' as never, messageId: 'q' as never, placement: 'queued', text, preview: text, content: [{ type: 'text', text }] }] })
    })
    const { container } = all(h); point(); draft('排队正文'); fireEvent.click(sendButton())
    await screen.findByText('排队消息 · 排队中')
    expect(screen.getByText('排队正文')).toBeTruthy()
    expect(container.textContent).not.toContain('[DSH kennel recipient]')
    fireEvent.click(screen.getByRole('button', { name: '查看 同名 · 机器1 · 开发 的消息' }))
    expect(screen.queryByText('排队正文')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }))
    expect(screen.getByText('排队正文')).toBeTruthy()
    act(() => { h.session.update((d) => { d.queue = []; d.nodes = [{ kind: 'user', seq: 1, time: 1, source: null, content: [{ type: 'text', text }] }] }) })
    expect(screen.queryByText('排队消息 · 排队中')).toBe(null)
    expect(screen.getAllByText('排队正文')).toHaveLength(1)
  })
  it('distinguishes waiting, failed and unknown task states and hides diagnostic metadata initially', () => {
    const h = harness()
    patchRoom(h, current => ({ ...current, tasks: [{
      runId: 'r', title: '状态任务', state: 'running', revision: 1, createdAt: 'now', updatedAt: 'now',
      nodes: ['pending', 'running', 'failed', 'future-state'].map((state, i) => ({
        nodeId: `n${i}`, title: `节点${i}`, state, attempt: 1, capabilityGeneration: 1, evidenceRefs: [],
      })),
    }] }))
    all(h)
    expect(screen.getByText('节点0 · 等待调度')).toBeTruthy()
    expect(screen.getByText('节点1 · 执行中')).toBeTruthy()
    expect(screen.getByText('任务未完成，暂无封存结果。')).toBeTruthy()
    expect(screen.getByText('节点3 · 未知状态：future-state')).toBeTruthy()
    expect(screen.queryByText(/不要重复派单/)).toBe(null)
    expect(screen.queryByText(/generation/)).toBe(null)
    fireEvent.click(screen.getAllByRole('button', { name: '展开执行记录' })[0]!)
    expect(screen.getByText('尝试 1 · generation 1')).toBeTruthy()
    expect(h.send).not.toHaveBeenCalled()
  })
  it('shows each member as working in the transcript until its result is sealed, and says when it did not finish', () => {
    const h = harness()
    const task = (state: string, result?: object) => ({
      runId: 'r', title: '大家有什么建议', state: 'running', revision: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: 'now',
      nodes: [{ nodeId: 'work', title: '大家有什么建议', state, attempt: 1, capabilityGeneration: 1, gouziId: 'g1', evidenceRefs: [], ...result === undefined ? {} : { result } }],
    })
    patchRoom(h, current => ({ ...current, tasks: [task('running')] as never }))
    const { container } = all(h)
    const progress = container.querySelector('[data-node-state="running"]')
    expect(progress?.getAttribute('role')).toBe('status')
    expect(progress?.textContent).toBe('同名 · 机器0 · 开发 · 执行中')

    act(() => { patchRoom(h, current => ({ ...current, tasks: [task('failed')] as never })) })
    expect(container.querySelector('[data-node-state="running"]')).toBe(null)
    expect(container.querySelector('[data-node-state="failed"]')?.textContent).toBe('同名 · 机器0 · 开发 · 执行失败')

    act(() => { patchRoom(h, current => ({ ...current, tasks: [task('passed', {
      sequence: 3, time: '2026-10-06T00:00:05.000Z', evidenceRef: 'ref', outputPreview: '先明确目标，再列方案。', accepted: true, operatorId: 'g1.codex',
    })] as never })) })
    expect(container.querySelector('[data-node-state]')).toBe(null)
    expect(screen.getByText('先明确目标，再列方案。')).toBeTruthy()
  })
  it('does not repeat a task title that is the same as its node title in the result card', () => {
    const h = harness()
    const node = (title: string) => ({ nodeId: 'work', title, state: 'passed', attempt: 1, capabilityGeneration: 1, gouziId: 'g1', evidenceRefs: [], result: {
      sequence: 1, time: '2026-10-06T00:00:00.000Z', evidenceRef: 'ref', outputPreview: '答复', accepted: true, operatorId: 'g1.codex',
    } })
    patchRoom(h, current => ({ ...current, tasks: [{ runId: 'same', title: '大家有什么建议', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [node('大家有什么建议')] },
      { runId: 'differs', title: '整理文档', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [node('检查')] }] as never }))
    const { container } = all(h)
    const cards = [...container.querySelectorAll('article')].filter(card => card.textContent?.includes('答复'))
    expect(cards).toHaveLength(2)
    const [same, differs] = [cards.find(card => !card.textContent?.includes('整理文档')), cards.find(card => card.textContent?.includes('整理文档'))]
    expect(same?.textContent).not.toContain('大家有什么建议')
    expect(differs?.textContent).toContain('整理文档 / 检查')
  })
  it('interleaves an older sealed task result before a newer user message using actual timestamps', () => {
    const h = harness()
    h.session.update((d) => {
      d.nodes = [
        { kind: 'user', seq: 1, time: Date.parse('2026-10-06T00:00:00.000Z'), source: null, content: [{ type: 'text', text: '较早用户消息' }] },
        { kind: 'user', seq: 2, time: Date.parse('2026-10-06T00:02:00.000Z'), source: null, content: [{ type: 'text', text: '最新用户消息' }] },
      ]
    })
    patchRoom(h, current => ({ ...current, tasks: [{ runId: 'r', title: '任务', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [{ nodeId: 'n', title: '节点', state: 'passed', attempt: 1, capabilityGeneration: 1, evidenceRefs: ['ref'], operatorId: 'actual', result: { sequence: 100, time: '2026-10-06T00:01:00.000Z', evidenceRef: 'ref', outputPreview: '较早真实结果', accepted: true, operatorId: 'actual' } }] }] }))
    all(h)
    const log = screen.getByRole('log')
    expect(log.textContent.indexOf('较早用户消息')).toBeLessThan(log.textContent.indexOf('较早真实结果'))
    expect(log.textContent.indexOf('较早真实结果')).toBeLessThan(log.textContent.indexOf('最新用户消息'))
    expect(log.closest('section')!.hasAttribute('data-conversation-scroll-owner')).toBe(true)
    expect(log.querySelector('form')).toBe(null)
    expect(document.querySelectorAll('form')).toHaveLength(1)
  })
  it('keeps the independently mounted composer inert under the core model block', () => {
    const h = harness(); h.props.blocked = { reason: '请选择可用模型' }
    all(h); draft()
    expect(sendButton()).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toBe('请选择可用模型')
    fireEvent.click(sendButton()); expect(h.send).not.toHaveBeenCalled()
  })
  it('offers explicit room reread after the first failure and surfaces callback errors', async () => {
    const h = harness()
    h.state.set({ room: null, loading: false, stale: true, error: 'first read lost' })
    h.reload.mockRejectedValue(new Error('scope disappeared'))
    all(h)
    expect(screen.getByRole('alert').textContent).toContain('尚未读取到房间资料')
    expect(screen.queryByText('暂无成员。可在设置的“狗子”页面查看或领养。')).toBe(null)
    expect(screen.queryByText('本房间尚无已接纳的任务。')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await screen.findByText('重新读取失败：scope disappeared')
    expect(h.reload).toHaveBeenCalledOnce()
  })
  it('preserves the historical scroll position when a result arrives', () => {
    const h = harness(); all(h)
    const log = screen.getByRole('log')
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    log.scrollTop = 100; fireEvent.scroll(log)
    act(() => { h.session.update((d) => { d.nodes = [{ kind: 'user', seq: 2, time: 2, content: [{ type: 'text', text: '新消息' }], source: null }] }) })
    expect(log.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(log.scrollTop).toBe(1000)
  })
})
describe('room source and transport', () => {
  it('shares polling, publishes stale failures and aborts only after the last subscriber', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async (_signal: AbortSignal) => ({ ...room(), roomPollIntervalMs: 250 }))
    const source = new KennelRoomSource('s', load)
    const stopA = source.subscribe(vi.fn()); const stopB = source.subscribe(vi.fn())
    await source.reload(); expect(load).toHaveBeenCalledOnce()
    expect(source.getSnapshot().stale).toBe(false)
    stopA(); load.mockRejectedValue(new Error('network lost'))
    await vi.advanceTimersByTimeAsync(250)
    expect(source.getSnapshot()).toMatchObject({ stale: true, error: 'network lost', room: { sessionId: 's' } })
    stopB(); await vi.advanceTimersByTimeAsync(1_000); expect(load).toHaveBeenCalledTimes(2)
    await source.dispose()
  })
  it('uses the Host-confirmed 250ms interval after both successful and failed reads', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async (_signal: AbortSignal) => ({ ...room(), roomPollIntervalMs: 250 }))
    const source = new KennelRoomSource('s', load)
    source.subscribe(vi.fn()); await source.reload()
    await vi.advanceTimersByTimeAsync(249); expect(load).toHaveBeenCalledTimes(1)
    load.mockRejectedValueOnce(new Error('later read lost'))
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toMatchObject({ stale: true, error: 'later read lost', room: { roomPollIntervalMs: 250 } })
    await vi.advanceTimersByTimeAsync(249); expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(3)
    await source.dispose()
  })
  it('does not schedule an unconfirmed interval after first-read failure and resumes only after explicit reload', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async (_signal: AbortSignal) => ({ ...room(), roomPollIntervalMs: 250 }))
      .mockRejectedValueOnce(new Error('first read lost'))
    const source = new KennelRoomSource('s', load)
    source.subscribe(vi.fn()); await source.reload()
    expect(source.getSnapshot()).toMatchObject({ room: null, stale: true, error: 'first read lost' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000); expect(load).toHaveBeenCalledTimes(1)
    await source.reload(); expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(249); expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(3)
    await source.dispose()
  })
  it.each([undefined, null, '250', 0, 249, 60_001, 250.5])('rejects missing or invalid Host interval %s without applying a default', async (roomPollIntervalMs) => {
    const request = vi.fn<BrowserRequest>(async () => Response.json({ ...room(), roomPollIntervalMs }))
    await expect(loadKennelRoom(request, 's')).rejects.toThrow('Invalid kennel room')
  })
  it.each([250, 2_000, 60_000])('accepts the validated Host interval %s verbatim', async (roomPollIntervalMs) => {
    const request = vi.fn<BrowserRequest>(async () => Response.json({ ...room(), roomPollIntervalMs }))
    expect((await loadKennelRoom(request, 's')).roomPollIntervalMs).toBe(roomPollIntervalMs)
  })
  it('fences late replies and awaits quiescence', async () => {
    let finish!: (r: GouziRoomSnapshotV1) => void
    let signal!: AbortSignal
    const source = new KennelRoomSource('s', (s) => { signal = s; return new Promise((resolve) => { finish = resolve }) })
    const listener = vi.fn(); source.subscribe(listener)
    await Promise.resolve()
    const disposing = source.dispose(); expect(signal.aborted).toBe(true)
    const count = listener.mock.calls.length
    finish(room()); await disposing
    expect(listener).toHaveBeenCalledTimes(count)
    expect(source.getSnapshot().room).toBe(null)
  })
  it('rejects invalid available flags and mismatched result operators at the wire reader', async () => {
    const data = room() as unknown as { execution: { operators: { available: unknown }[] }[] }
    data.execution[0]!.operators[0]!.available = 'true'
    await expect(loadKennelRoom(vi.fn(async () => Response.json(data)) as never, 's')).rejects.toThrow('Invalid kennel room reply')
    const invalid = { ...room(), tasks: [{ runId: 'r', title: 'task', state: 'done', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [{ nodeId: 'n', title: 'node', state: 'done', attempt: 1, capabilityGeneration: 1, evidenceRefs: [], operatorId: 'actual', result: { sequence: 1, time: '2026-10-06T00:00:00.000Z', evidenceRef: 'ref', outputPreview: 'wrong', accepted: true, operatorId: 'other' } }] }] }
    await expect(loadKennelRoom(vi.fn(async () => Response.json(invalid)) as never, 's')).rejects.toThrow('Invalid kennel room reply')
  })
  it('shows the outcomes of collaborations about a task on that task, and accepts them from the Host only when well-formed', async () => {
    const task = (outcomes: unknown) => ({
      runId: 'r', title: '被评审任务', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now', nodes: [], ...outcomes === undefined ? {} : { outcomes },
    })
    const good = [{ collaboration: 'review', runId: 'rv', state: 'negative', label: '评审：待修改（乙）' }, { collaboration: 'review', runId: 'rv2', state: 'positive', label: '评审：已通过（丙）' }]
    const load = (value: unknown) => loadKennelRoom(vi.fn(async () => Response.json({ ...room(), tasks: [task(value)] })), 's')
    expect((await load(good)).tasks[0]!.outcomes).toEqual(good)
    expect((await load(undefined)).tasks[0]!.outcomes).toBeUndefined()
    for (const bad of ['x', [null], [{ ...good[0], state: 'done' }], [{ ...good[0], label: 1 }], [{ ...good[0], runId: '' }], [{ ...good[0], collaboration: '' }]]) {
      await expect(load(bad)).rejects.toThrow('Invalid kennel room reply')
    }
    const h = harness()
    patchRoom(h, current => ({ ...current, tasks: [task(good) as never] }))
    all(h)
    expect(screen.getByText('评审：待修改（乙）').getAttribute('data-outcome')).toBe('negative')
    expect(screen.getByText('评审：已通过（丙）').getAttribute('data-outcome')).toBe('positive')
  })
  it('shows each collaboration as a card with its kind, state, task, outcome, and members, and a sentence when there are none', async () => {
    const collaboration = (patch: Record<string, unknown> = {}) => ({
      collaboration: 'review', label: '评审', runId: 'rv', state: 'completed', subject: { runId: 'r', title: '被评审任务' },
      outcome: { state: 'negative', label: '评审：待修改（同名）' },
      members: [
        { gouziId: 'g1', role: 'reviewer', roleLabel: '评审人', conclusion: '需要修改', text: '缺**测试**' },
        { gouziId: 'g2', role: 'reviewer', roleLabel: '评审人', conclusion: '通过' },
        { gouziId: 'ghost', role: 'seat', roleLabel: '席位' },
      ], ...patch,
    })
    const load = (value: unknown) => loadKennelRoom(vi.fn(async () => Response.json({ ...room(), collaborations: value })), 's')
    const good = [collaboration(), { collaboration: 'debate', label: '辩论', runId: 'dr', state: 'running', members: [] }]
    const unread = { collaboration: 'debate', label: '辩论', runId: 'du', state: 'unknown', members: [] }
    expect((await load(good)).collaborations).toEqual(good)
    expect((await load(undefined)).collaborations).toBeUndefined()
    const bad: unknown[] = [
      'x', [null], [collaboration({ collaboration: '' })], [collaboration({ label: 1 })], [collaboration({ runId: '' })], [collaboration({ state: 1 })],
      [collaboration({ subject: { runId: '', title: 't' } })], [collaboration({ subject: { runId: 'r', title: 1 } })],
      [collaboration({ outcome: { state: 'done', label: 'l' } })], [collaboration({ outcome: { state: 'negative', label: 1 } })],
      [collaboration({ members: 'x' })], [collaboration({ members: [null] })], [collaboration({ members: [{ gouziId: '', role: 'r', roleLabel: 'r' }] })],
      [collaboration({ members: [{ gouziId: 'g1', role: 1, roleLabel: 'r' }] })], [collaboration({ members: [{ gouziId: 'g1', role: 'r', roleLabel: 1 }] })],
      [collaboration({ members: [{ gouziId: 'g1', role: 'r', roleLabel: 'r', conclusion: 1 }] })],
      [collaboration({ members: [{ gouziId: 'g1', role: 'r', roleLabel: 'r', text: 1 }] })],
    ]
    for (const value of bad) await expect(load(value)).rejects.toThrow('Invalid kennel room reply')

    const h = harness()
    patchRoom(h, current => ({ ...current, collaborations: good as never }))
    all(h)
    const card = screen.getByRole('article', { name: '评审协作' })
    expect(card.textContent).toContain('针对任务：被评审任务')
    expect(within(card).getByText('评审：待修改（同名）').getAttribute('data-outcome')).toBe('negative')
    expect(card.textContent).toContain('评审人')
    expect(card.textContent).toContain('需要修改')
    expect(card.textContent).toContain('席位')
    // Names, not the roster label, and the comments are behind a disclosure rather than always open.
    expect(card.textContent).not.toContain('机器0')
    fireEvent.click(within(card).getByText('查看意见'))
    expect(within(card).getByText('测试').tagName).toBe('STRONG')
    expect(screen.getByRole('article', { name: '辩论协作' }).textContent).toContain('执行中')
    // A state nobody could read is left out instead of shown as an unknown state.
    cleanup()
    const unreadRoom = harness()
    patchRoom(unreadRoom, current => ({ ...current, collaborations: [unread] as never }))
    all(unreadRoom)
    expect(screen.getByRole('article', { name: '辩论协作' }).textContent).toBe('辩论')

    const none = harness()
    all(none)
    expect(screen.getAllByText(/本房间还没有协作/)).toHaveLength(1)
  })
  it.each(['not-a-time', '2026-10-06', '2026-02-30T00:00:00.000Z'])('rejects invalid actual result time %s', async (time) => {
    const snapshot = { ...room(), tasks: [{
      runId: 'r', title: 'task', state: 'completed', revision: 1, createdAt: 'now', updatedAt: 'now',
      nodes: [{ nodeId: 'n', title: 'node', state: 'passed', attempt: 1, capabilityGeneration: 1, evidenceRefs: ['ref'],
        operatorId: 'actual', result: { time, sequence: 1, evidenceRef: 'ref', outputPreview: 'actual', accepted: true, operatorId: 'actual' } }],
    }] }
    await expect(loadKennelRoom(vi.fn(async () => Response.json(snapshot)) as never, 's')).rejects.toThrow('Invalid kennel room reply')
  })
  it('uses exact room and evidence query parameters and surfaces Host refusal', async () => {
    const request = vi.fn<BrowserRequest>(async () => Response.json(room()))
    await loadKennelRoom(request, 's')
    const url = request.mock.calls[0]![0]
    if (!(url instanceof URL)) throw new Error('Expected a room request URL')
    expect(url.searchParams.get('session_id')).toBe('s')
    await readKennelEvidence(request, 's', 'run/x', 'evidence/x')
    const evidenceUrl = request.mock.calls[1]![0]
    if (!(evidenceUrl instanceof URL)) throw new Error('Expected an evidence request URL')
    expect(evidenceUrl.searchParams.get('run_id')).toBe('run/x')
    expect(evidenceUrl.searchParams.get('evidence_ref')).toBe('evidence/x')
    request.mockImplementation(async () => Response.json({ message: 'forbidden evidence' }, { status: 403 }))
    await expect(readKennelEvidence(request, 's', 'r', 'e')).rejects.toThrow('forbidden evidence')
  })
})
