/** The kennel room's three normal-flow slots; business data arrives through framework hooks. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationNode, ObservableSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { decodeKennelMessage, type KennelRecipient } from '../recipient-message.ts'
import { GOUZI_ROLE_COPY, GOUZI_STATE_COPY, type GouziRoomSnapshotV1, type GouziRoomTaskV1, type GouziRoomNodeV1, type GouziRoomResultV1 } from '../contracts.ts'
import { GouziAvatarImage } from './avatars.tsx'
import type { KennelRoomReadState } from './room-source.ts'
import type { KennelRoomStore } from './room-store.ts'
import css from './KennelRoom.module.css'

/** Narrow JSON callbacks and the single room business source bound by apply. */
export interface KennelRoomInjected {
  hooks: { room: ObservableSnapshot<KennelRoomReadState> }
  send: (message: { text: string; recipient: KennelRecipient | null }) => Promise<void>
  readEvidence: (runId: string, ref: string) => Promise<unknown>
  loadOlder: () => Promise<void>
  reload: () => Promise<void>
}
type RoomBusinessProps = PropsStore<KennelRoomStore> & InjectFace<KennelRoomInjected>
/** Header props derive from the header's own slot currency. */
export type KennelRoomHeaderProps = PropsRuntime<'conversation.room.header'> & RoomBusinessProps
/** Aside props derive from the aside's own slot currency. */
export type KennelRoomAsideProps = PropsRuntime<'conversation.room.aside'> & RoomBusinessProps
/** Transcript props derive from the content's own slot currency. */
export type KennelRoomProps = PropsRuntime<'conversation.room.content'> & RoomBusinessProps
/** Composer props include the core owner's inert and model-block state. */
export type KennelRoomComposerProps = PropsRuntime<'conversation.room.composer'> & RoomBusinessProps

function memberLabel(room: GouziRoomSnapshotV1 | null | undefined, id: string): string {
  const member = room?.dashboard.members.find(m => m.gouziId === id)
  return member ? `${member.name} · ${member.hostLabel} · ${GOUZI_ROLE_COPY[member.role].label}` : id
}
function memberName(room: GouziRoomSnapshotV1 | null | undefined, id: string): string {
  return room?.dashboard.members.find(m => m.gouziId === id)?.name ?? id
}
function recipientBlock(state: KennelRoomReadState | undefined, recipient: KennelRecipient | null): string | null {
  if (!recipient) return null
  if (!state || state.stale || !state.room) return '房间资料尚未确认或已过期，保留原发送对象，请刷新后核对。'
  const member = state.room.dashboard.members.find(m => m.gouziId === recipient.gouziId)
  if (!member || member.membership !== 'enabled') return '原发送对象当前不可用；目标已保留。'
  const execution = state.room.execution.find(e => e.gouziId === recipient.gouziId)
  if (!execution || execution.generation !== recipient.generation) return '执行实例已变化，请重新点名；原目标已保留。'
  if (execution.projectScopes.length === 0) return '原发送对象的项目尚未确认；目标已保留，暂不能发送。'
  if (!execution.operators.some(o => o.available)) return '原发送对象没有可用执行入口；目标已保留。'
  if (!execution.operators.some(o => o.available && o.supportsGenerationLimits === true)) return '原发送对象的执行入口不支持聊天任务所需的执行限制；目标已保留，暂不能发送。'
  return null
}

const TASK_STATE_COPY: Readonly<Record<string, string>> = {
  awaiting_clarification: '等待澄清', awaiting_approval: '等待批准', running: '执行中', paused: '已暂停',
  completed: '执行结束', failed: '执行失败', cancelled: '已取消', indeterminate: '执行结果待核对',
  pending: '等待调度', ready: '等待执行', awaiting_recompile: '等待更新执行计划', retry_wait: '等待重试',
  passed: '执行结束', blocked: '执行受阻',
}
function taskState(state: string): string {
  const copy = Object.hasOwn(TASK_STATE_COPY, state) ? TASK_STATE_COPY[state] : undefined
  return copy ?? `未知状态：${state}`
}
function noResult(state: string): string {
  if (state === 'indeterminate') return '需核对原执行，不要重复派单。'
  if (state === 'failed' || state === 'cancelled' || state === 'blocked') return '任务未完成，暂无封存结果。'
  if (state === 'passed' || state === 'completed') return '执行已结束，暂无封存结果；验收尚未确认。'
  return '尚无封存结果，请等待原任务状态更新。'
}
function displayMessage(text: string): ReturnType<typeof decodeKennelMessage> {
  try { return decodeKennelMessage(text) }
  catch { return { text: '指定对象记录格式无效，请核对原记录。' } }
}

interface RoomResultRow {
  task: GouziRoomTaskV1
  node: GouziRoomNodeV1
  result: GouziRoomResultV1
  key: string
}
type RoomTranscriptRow = { kind: 'message'; node: ConversationNode; key: string; time: number; seq: number }
  | { kind: 'tool'; node: ChatNode<'tool-call'>; key: string; time: number; seq: number }
type RoomRow = RoomTranscriptRow | { kind: 'result'; entry: RoomResultRow; key: string }
function compareKeys(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function durableRows(nodes: readonly ConversationNode[], tools: readonly ChatNode<'tool-call'>[], results: readonly RoomResultRow[]): RoomRow[] {
  const ordered = [...results].sort((a, b) => Date.parse(a.result.time) - Date.parse(b.result.time) || compareKeys(a.key, b.key))
  const transcript: RoomTranscriptRow[] = nodes.map(node => ({ kind: 'message', node, key: `message:${node.kind}:${node.seq}`, time: node.time, seq: node.seq }))
  transcript.push(...tools.map(node => ({ kind: 'tool' as const, node, key: `tool:${node.key}`, time: node.data.root.time, seq: node.anchorSeq })))
  transcript.sort((a, b) => a.time - b.time || a.seq - b.seq || compareKeys(a.key, b.key))
  const rows: RoomRow[] = []
  let index = 0
  for (const row of transcript) {
    let entry = ordered[index]
    while (entry) {
      const time = Date.parse(entry.result.time)
      if (time > row.time || time === row.time && compareKeys(entry.key, row.key) >= 0) break
      rows.push({ kind: 'result', entry, key: entry.key }); index++
      entry = ordered[index]
    }
    rows.push(row)
  }
  for (const entry of ordered.slice(index)) rows.push({ kind: 'result', entry, key: entry.key })
  return rows
}

function ToolActivity({ block }: { block: ToolCallBlock }) {
  const settled = 'kind' in block
  const name = settled ? block.call?.name ?? block.callId : block.name
  const text = settled ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  return <div><strong>工具 · {name}</strong><p>{settled ? block.isError ? '执行失败' : '执行结束' : '执行中'}</p>
    {settled && block.error && <p className={css.error}>{block.error.name} · {block.error.code}</p>}
    {text && <MarkdownText text={text} />}
    {block.subCalls.map(child => <ToolActivity key={child.callId} block={child} />)}
  </div>
}

/** @param props - framework room props. @returns persistent room title and workspace context. */
export function KennelRoomHeader({ useRoom, useWorkspaces, useSessions, sessionId }: KennelRoomHeaderProps) {
  const state = useRoom(s => s)
  const workspace = useWorkspaces(s => s.items.find(w => sessionId !== undefined && w.sessionIds.includes(sessionId)))
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  return <header className={css.header}><div><h1>狗窝</h1><p>{workspace?.title ?? cwd ?? '工作区上下文尚未读取'}</p></div><span>{state.room ? `${state.room.dashboard.members.length + 2} 人 · 我 / 总管 / ${state.room.dashboard.members.length} 只狗子` : '人数尚未读取'}</span></header>
}

/** @param props - framework room props. @returns persistent members and exact-session task cards. */
export function KennelRoomAside({ useRoom, useStore, actions }: KennelRoomAsideProps) {
  const state = useRoom(s => s)
  const filter = useStore(s => s.filter)
  const recipient = useStore(s => s.recipient)
  const expanded = useStore(s => s.expandedEvidence)
  const room = state.room
  return <aside className={css.aside} aria-label="房间成员与任务">
    <details open className={css.section}><summary>房间成员</summary>
      <div className={css.filters}><Button size="sm" variant={filter === 'all' ? 'outline' : 'ghost'} onClick={() => { actions.filter('all') }}>全部</Button><Button size="sm" onClick={() => { actions.filter('manager') }}>总管</Button></div>
      <p className={css.muted}>我 · 总管</p>
      {room?.dashboard.members.map((member) => {
        const execution = room.execution.find(e => e.gouziId === member.gouziId)
        const projectUnconfirmed = execution !== undefined && execution.projectScopes.length === 0
        const limitsUnsupported = execution !== undefined && execution.operators.some(o => o.available)
          && !execution.operators.some(o => o.available && o.supportsGenerationLimits === true)
        const available = !state.stale && member.membership === 'enabled' && execution !== undefined && execution.generation > 0 && !projectUnconfirmed && execution.operators.some(o => o.available && o.supportsGenerationLimits === true)
        return <article className={css.card} key={member.gouziId}>
          <Button className={css.member} aria-label={`发给 ${memberLabel(room, member.gouziId)}`} aria-pressed={recipient?.gouziId === member.gouziId} disabled={!available} onClick={() => { if (available) actions.recipient({ gouziId: member.gouziId, generation: execution.generation, mode: 'standard' }) }}><GouziAvatarImage avatarId={member.avatarId} size={32} /><strong>{member.name}</strong></Button>
          <p>{member.hostLabel} · {GOUZI_ROLE_COPY[member.role].label}</p><p>{GOUZI_STATE_COPY[member.state]} · {member.connection === 'online' ? '在线' : '联系不上'} · {available ? '执行入口可用' : '执行入口不可用'}</p>
          {projectUnconfirmed && <p className={css.muted}>项目尚未确认，暂不能向该成员发送。</p>}
          {limitsUnsupported && <p className={css.muted}>当前执行入口不支持聊天任务所需的执行限制，暂不能点名发送。</p>}
          <Button size="sm" variant="outline" aria-label={`查看 ${memberLabel(room, member.gouziId)} 的消息`} aria-pressed={filter === member.gouziId} onClick={() => { actions.filter(member.gouziId) }}>查看消息</Button>
        </article>
      })}
      {room?.dashboard.members.length === 0 && <p className={css.empty}>暂无成员。可在设置的“狗子”页面查看或领养。</p>}
    </details>
    <details open className={css.section}><summary>本房间任务</summary>
      {room?.tasks.length === 0 && <p className={css.empty}>本房间尚无已接纳的任务。</p>}
      {room?.tasks.map(task => <article className={css.card} key={task.runId}>
        <strong>{task.title}</strong><p>状态：{taskState(task.state)}</p>
        {task.nodes.map((node) => {
          const key = `task:${task.runId}:${node.nodeId}:${node.attempt}:${node.capabilityGeneration}`
          return <div key={key} className={css.task}>
            <p>{node.title} · {taskState(node.state)}</p>
            {node.result ? <p>执行结束 · {node.result.accepted ? '结果已接纳' : '结果未接纳'}</p> : <p>{noResult(node.state)}</p>}
            <Button size="sm" onClick={() => { actions.evidence(key) }}>{expanded[key] ? '收起执行记录' : '展开执行记录'}</Button>
            {expanded[key] && <div className={css.muted}><p>尝试 {node.attempt} · generation {node.capabilityGeneration}</p>
              <p>执行者：{node.operatorId ?? '尚未封存执行者'}</p><p>证据：{node.evidenceRefs.length ? node.evidenceRefs.join('，') : '暂无'}</p>
            </div>}
          </div>
        })}
      </article>)}
    </details>
  </aside>
}

/** @param props - framework room props. @returns transcript in one owned scrollport. */
export function KennelRoomContent({ useRoom, useSession, useStore, actions, readEvidence, loadOlder, reload }: KennelRoomProps) {
  const state = useRoom(s => s)
  const nodes = useSession(s => s.nodes)
  const chat = useSession(s => s.chat)
  const partial = useSession(s => s.partial)
  const inbox = useSession(s => s.queue)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const filter = useStore(s => s.filter)
  const expanded = useStore(s => s.expandedEvidence)
  const [evidence, setEvidence] = useState<Record<string, { text?: string; error?: string; loading?: boolean }>>({})
  const scrollport = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [latest, setLatest] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [reloadError, setReloadError] = useState<string | null>(null)
  const [paging, setPaging] = useState(false)
  const pagingAnchor = useRef<{ key: string; top: number; nodes: typeof nodes } | null>(null)
  const room = state.room
  const results = room?.tasks.flatMap(task => task.nodes.flatMap(node => node.result ? [{ task, node, result: node.result, key: `${task.runId}:${node.nodeId}:${node.attempt}:${node.capabilityGeneration}:${node.result.sequence}` }] : [])) ?? []
  const visibleResults = results.filter(r => filter === 'all' || (filter !== 'manager' && r.node.gouziId === filter))
  const visiblePartial = (filter === 'all' || filter === 'manager') ? partial : null
  const tools = filter === 'all' || filter === 'manager'
    ? chat?.order.flatMap((key) => { const node = chat.nodes.get(key); return node?.visibility === 'visible' && node.kind === 'tool-call' ? [node as ChatNode<'tool-call'>] : [] }) ?? []
    : []
  const visibleNodes = nodes?.filter((node) => {
    if (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'assistant' && node.kind !== 'turn-error' && node.kind !== 'tool-result') return false
    if (node.kind === 'tool-result' && tools.some(tool => tool.data.root.callId === node.callId)) return false
    if (filter === 'all' || node.kind === 'turn-error') return true
    if (node.kind === 'user' || node.kind === 'steering') {
      const text = node.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      try { return (decodeKennelMessage(text).recipient?.gouziId ?? 'manager') === filter }
      catch { return filter === 'manager' }
    }
    return filter === 'manager'
  }) ?? []
  const queued = inbox?.filter(item => item.placement === 'queued').map(item => ({
    item, decoded: displayMessage(item.text ?? (item.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || item.preview)),
  })).filter(({ decoded }) => filter === 'all' || (decoded.recipient?.gouziId ?? 'manager') === filter) ?? []
  function captureAnchor(): void {
    const element = scrollport.current
    if (!element) return
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>('[data-room-anchor]')].find(r => r.getBoundingClientRect().bottom > top)
    if (row?.dataset.roomAnchor) pagingAnchor.current = { key: row.dataset.roomAnchor, top: row.getBoundingClientRect().top, nodes }
  }
  useLayoutEffect(() => {
    const anchor = pagingAnchor.current
    const element = scrollport.current
    if (!anchor || !element || anchor.nodes === nodes) return
    const row = [...element.querySelectorAll<HTMLElement>('[data-room-anchor]')].find(r => r.dataset.roomAnchor === anchor.key)
    if (row) element.scrollTop += row.getBoundingClientRect().top - anchor.top
    pagingAnchor.current = null
  }, [nodes])
  async function older(): Promise<void> {
    if (paging || loadingOlder || !hasMore) return
    captureAnchor(); atBottom.current = false
    setPaging(true); setHistoryError(null)
    try { await loadOlder() }
    catch (failure) { pagingAnchor.current = null; setHistoryError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setPaging(false) }
  }
  useEffect(() => {
    const element = scrollport.current
    if (!element) return
    if (atBottom.current) element.scrollTop = element.scrollHeight
    else setLatest(true)
  }, [nodes, partial, room, inbox])
  async function reread(): Promise<void> {
    setReloadError(null)
    try { await reload() }
    catch (failure) { setReloadError(failure instanceof Error ? failure.message : String(failure)) }
  }
  async function toggleEvidence(key: string, runId: string, ref: string): Promise<void> {
    actions.evidence(key)
    if (expanded[key] || evidence[key]?.text !== undefined || evidence[key]?.loading) return
    setEvidence(old => ({ ...old, [key]: { loading: true } }))
    try {
      const body = await readEvidence(runId, ref)
      setEvidence(old => ({ ...old, [key]: { text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) } }))
    } catch (failure) { setEvidence(old => ({ ...old, [key]: { error: failure instanceof Error ? failure.message : String(failure) } })) }
  }
  return <section className={css.content} data-conversation-scroll-owner="" aria-label="狗窝聊天">
    {state.error && <div><p className={css.error} role="alert">读取失败：{state.error}。{state.room ? '上次资料已过期。' : '尚未读取到房间资料。'}</p>
      <Button size="sm" disabled={state.loading} onClick={() => { void reread() }}>重新读取</Button>
    </div>}
    {reloadError && <p className={css.error} role="alert">重新读取失败：{reloadError}</p>}
    {state.stale && !state.error && <p className={css.muted}>正在核对房间资料；旧资料不能确认执行可用。</p>}
    <div className={css.scrollport} ref={scrollport} role="log" aria-label="聊天记录" onScroll={() => { const e = scrollport.current; if (e) { atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight <= 1; if (atBottom.current) setLatest(false); if (paging) captureAnchor() } }}>
      {hasMore && <Button disabled={paging || loadingOlder} onClick={() => { void older() }}>{paging || loadingOlder ? '加载中…' : '加载更早记录'}</Button>}
      {historyError && <p className={css.error} role="alert">历史读取失败：{historyError}</p>}
      {durableRows(visibleNodes, tools, visibleResults).map((row) => {
        if (row.kind === 'tool') return <article className={css.message} data-room-anchor={row.key} key={row.key}><ToolActivity block={row.node.data.root} /></article>
        if (row.kind === 'message') {
          const node = row.node
          if (node.kind === 'turn-error') return <article className={css.message} data-room-anchor={`${node.kind}:${node.seq}`} key={row.key}><strong>总管 · 执行失败</strong><p className={css.error} role="alert">{node.message}{node.code && `（${node.code}）`}</p></article>
          if (node.kind === 'tool-result') return <article className={css.message} data-room-anchor={`${node.kind}:${node.seq}`} key={row.key}><ToolActivity block={node} /></article>
          const user = node.kind === 'user' || node.kind === 'steering'
          const text = user ? node.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : node.kind === 'assistant' ? node.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n') : ''
          let decoded: ReturnType<typeof decodeKennelMessage> = { text }
          let invalid = false
          if (user) { try { decoded = decodeKennelMessage(text) } catch { decoded = { text: '指定对象记录格式无效，请核对原记录。' }; invalid = true } }
          return <article className={css.message} data-room-anchor={`${node.kind}:${node.seq}`} key={`${node.kind}:${node.seq}`}><strong>{user ? '我' : node.kind === 'assistant' ? '总管' : '执行记录'}</strong>{decoded.recipient && <p className={css.muted}>发给 {memberName(room, decoded.recipient.gouziId)}</p>}{text || invalid ? <MarkdownText text={decoded.text} /> : <p>{node.kind === 'assistant' ? '总管正在执行工具或生成非文本内容。' : `${node.kind} · 序号 ${node.seq}`}</p>}</article>
        }
        const { task, node, result, key } = row.entry
        return <article className={css.result} key={key}><strong>{node.gouziId ? memberLabel(room, node.gouziId) : result.operatorId || '执行结果'} · 任务结果</strong><p>{task.title} / {node.title}</p><p>执行结束 · {result.accepted ? '结果已接纳' : '结果未接纳'}</p><MarkdownText text={result.outputPreview} /><Button size="sm" onClick={() => { void toggleEvidence(key, task.runId, result.evidenceRef) }}>{expanded[key] ? '收起证据' : '查看证据'}</Button>{expanded[key] && <div><p className={css.muted}>尝试 {node.attempt} · generation {node.capabilityGeneration}</p>{evidence[key]?.loading && <p>正在读取证据…</p>}{evidence[key]?.error && <p className={css.error} role="alert">{evidence[key].error}</p>}{evidence[key]?.text !== undefined && <pre className={css.evidence}>{evidence[key].text}</pre>}</div>}</article>
      })}

      {queued.map(({ item, decoded }) => <article className={css.message} key={`queue:${item.messageId}`}>
        <strong>排队消息 · 排队中</strong>
        {decoded.recipient && <p className={css.muted}>发给 {memberName(room, decoded.recipient.gouziId)}</p>}
        <MarkdownText text={decoded.text} />
      </article>)}
      {visiblePartial && <article className={css.message}><strong>总管</strong><MarkdownText text={visiblePartial.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n')} streaming /></article>}

      {!visibleNodes.length && !visibleResults.length && !tools.length && !queued.length && !visiblePartial && <p className={css.empty}>{filter === 'all' ? '房间还没有消息。可向总管提交请求，或从成员按钮确认点名对象。' : '当前筛选没有记录。可选择“全部”查看房间消息。'}</p>}
    </div>
    {latest && <Button onClick={() => {
      const e = scrollport.current
      if (e) e.scrollTop = e.scrollHeight
      atBottom.current = true; setLatest(false)
    }}>回到最新</Button>}

  </section>
}

/** @param props - core composer currency and shared room interaction state. @returns the kennel submission form. */
export function KennelRoomComposer({ useRoom, useSession, useStore, actions, send, inert, blocked: modelBlock }: KennelRoomComposerProps) {
  const state = useRoom(s => s)
  const removed = useSession(s => s.removed)
  const filter = useStore(s => s.filter)
  const recipient = useStore(s => s.recipient)
  const draft = useStore(s => s.draft)
  const notice = useStore(s => s.sentNotice)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = recipient ? memberName(state.room, recipient.gouziId) : '自动分派'
  const submissionNotice = notice
    ? notice.target === 'manager' ? '消息已提交 · 自动分派' : `消息已提交 · 发给 ${notice.label}`
    : null
  const blocked = modelBlock?.reason ?? recipientBlock(state, recipient)
  async function submit(): Promise<void> {
    if (sending || inert || blocked || removed || !draft.trim()) return
    const text = draft
    const target = recipient ? { ...recipient } : null
    setSending(true); setError(null)
    try { await send({ text, recipient: target }); actions.sent(text, label, target?.gouziId ?? 'manager') }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setSending(false) }
  }

  return <form className={css.composer} onSubmit={(e) => { e.preventDefault(); void submit() }}>
    {notice && <p role="status">{submissionNotice}{filter !== 'all' && filter !== notice.target && <>；被当前筛选隐藏 <Button size="sm" onClick={() => { actions.filter('all') }}>显示全部</Button></>}</p>}
    <div className={css.target}><span>{recipient ? `发给 ${label}` : '自动分派'}</span>{recipient && <Button size="sm" onClick={() => { actions.recipient(null) }}>清除点名</Button>}</div>
    <label className={css.draftLabel}>消息<textarea aria-label="消息" value={draft} onChange={(e) => { actions.draft(e.target.value) }} rows={3} /></label>
    {draft.includes('@') && !recipient && <p className={css.muted}>手写 @名字 不会指定对象；请点击成员的头像或名字选择。</p>}
    {blocked && <p className={css.error} role="status">{blocked}</p>}{error && <p className={css.error} role="alert">发送失败：{error}</p>}
    <div className={css.send}><Button variant="primary" type="submit" disabled={sending || inert || !!blocked || !!removed || !draft.trim()}>{sending ? '发送中…' : '发送'}</Button></div>
  </form>
}
