/** UI state derived only from this plugin's native compaction transactions. */
export const HANDOFF_COMPACTION_PREFIX = 'solar-model-handoff:'
export const PREPARING_REASON = '正在准备上下文，请稍候；完成交接前暂不能输入或发送。'
export interface ProgressEvent { readonly type: string; readonly seq: number; readonly data: unknown }
export interface ProgressWindow {
  readonly revision: number
  readonly entries: readonly { readonly type: string; readonly event: ProgressEvent }[]
  readonly change: { readonly kind: string; readonly entries?: readonly { readonly type: string; readonly event: ProgressEvent }[] }
}
export interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface PreparationState { readonly busy: boolean; readonly message: string; readonly fresh?: boolean }
interface Block { readonly reason: string }
interface Blocks<Id> {
  set(id: Id, block: Block | undefined): void
  storeFor(id: Id): Observable<Block | undefined>
}
function owned(event: ProgressEvent): event is ProgressEvent & { data: { compactionId: string; error?: unknown } } {
  return (event.type === 'compaction/start' || event.type === 'compaction/end')
    && typeof event.data === 'object' && event.data !== null && 'compactionId' in event.data
    && typeof event.data.compactionId === 'string' && event.data.compactionId.startsWith(HANDOFF_COMPACTION_PREFIX)
}
/** Rebuild from the authoritative loaded window, including reconnect/replacement. */
export function preparationState(window: ProgressWindow): PreparationState | undefined {
  let current: string | undefined
  let state: PreparationState | undefined
  let fresh = false
  for (const entry of window.entries) {
    const candidate = entry.event
    if (entry.type === 'event' && candidate.type === 'compaction/summary' && typeof candidate.data === 'object' && candidate.data !== null
      && 'compactionId' in candidate.data && candidate.data.compactionId === current && 'provider' in candidate.data && 'model' in candidate.data
      && candidate.data.provider === 'solar-model-handoff' && candidate.data.model === 'fresh-context') fresh = true
    if (entry.type !== 'event' || !owned(entry.event)) continue
    const event = entry.event
    if (event.type === 'compaction/start') {
      current = event.data.compactionId
      fresh = false
      state = { busy: true, message: PREPARING_REASON }
    } else if (current === undefined || current === event.data.compactionId) {
      current = undefined
      state = event.data.error === undefined ? fresh ? { busy: false, fresh: true,
        message: '已取消交接；新模型将从空白任务上下文开始，旧聊天记录仍可查看。' } : undefined : { busy: false,
        message: '交接未完成，未自动重试。可重新准备交接，或用 /handoff fresh 不携带旧任务上下文。' }
    }
  }
  return state
}
/** Own one UI subscription and only the block raised by this instance; never edit a draft. */
export class PreparationObserver<Id> implements Observable<PreparationState | undefined> {
  private state: PreparationState | undefined
  private readonly listeners = new Set<() => void>()
  private readonly block = { reason: PREPARING_REASON }
  private readonly disposeEvents: () => void
  private readonly disposeBlocks: () => void
  private revision = -1
  private disposed = false
  constructor(private readonly id: Id, private readonly events: Observable<ProgressWindow>, private readonly blocks: Blocks<Id>) {
    this.disposeEvents = events.subscribe(() => this.refresh())
    this.disposeBlocks = blocks.storeFor(id).subscribe(() => this.syncBlock())
    this.refresh()
  }
  getSnapshot = (): PreparationState | undefined => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private syncBlock(): void {
    const existing = this.blocks.storeFor(this.id).getSnapshot()
    if (this.state?.busy && !this.disposed) {
      if (existing === undefined) this.blocks.set(this.id, this.block)
    } else if (existing === this.block) this.blocks.set(this.id, undefined)
  }
  private refresh(): void {
    if (this.disposed) return
    const window = this.events.getSnapshot()
    const contiguous = window.revision === this.revision + 1
    this.revision = window.revision
    if (contiguous && window.change.kind === 'append' && !window.change.entries?.some(entry => entry.type === 'event' && owned(entry.event))) return
    const next = preparationState(window)
    if (next?.busy === this.state?.busy && next?.message === this.state?.message) return
    this.state = next
    this.syncBlock()
    for (const listener of this.listeners) listener()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeEvents()
    this.disposeBlocks()
    this.syncBlock()
    this.listeners.clear()
  }
}
