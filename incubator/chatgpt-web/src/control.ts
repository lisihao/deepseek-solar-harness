import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { WebController } from './controller.js'
import type { WebAbandonInput, WebIdInput, WebLaunchInput, WebUiStatus } from './ui-contract.js'
import type { WebRunRequest, WebRunRecord } from './store.js'

const idSchema = z.strictObject({ id: z.uuid() })
const requestSchema = z.strictObject({
  prompt: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 128 * 1024, 'WEB_INPUT_TOO_LARGE'),
  modelLabel: z.string().trim().min(1).max(120).optional(),
  effortLabel: z.string().trim().min(1).max(120).optional(),
})
const launchSchema = z.strictObject({ id: z.uuid(), request: requestSchema })
const abandonSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  acknowledgeUnknown: z.literal(true),
})

export class WebControl extends TypertRemoteService {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly errors = new Map<string, string>()
  private readonly pendingRequests = new Map<string, string>()
  constructor(ctx: Context, readonly controller: WebController, readonly defaults: Omit<WebRunRequest, 'prompt'> = {}) { super(ctx, 'solarChatGptWebControl') }
  private owner(): void {
    if (this.ctx.invocation !== undefined && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: 网页算子界面仅允许本机所有者操作。')
    }
  }
  @Remote
  async status(): Promise<WebUiStatus> {
    this.owner()
    return { runs: await this.controller.list(), activeIds: [...this.pending.keys()], errors: [...this.errors].map(([id, message]) => ({ id, message })) }
  }
  @Remote
  async launch(input: WebLaunchInput): Promise<{ id: string }> {
    this.owner()
    const value = launchSchema.parse(input)
    const request = { ...this.defaults, ...value.request }
    const fingerprint = JSON.stringify(request)
    if (this.pending.has(value.id) && this.pendingRequests.get(value.id) !== fingerprint) throw new Error('WEB_COMMAND_CONFLICT: 同一请求标识不能更换内容。')
    if (!this.pending.has(value.id)) {
      this.errors.delete(value.id)
      const pending = this.controller.start(value.id, request).catch(error => {
        this.errors.set(value.id, error instanceof Error ? error.message : '网页任务未完成，请查看任务记录。')
      }).finally(() => { if (this.pending.get(value.id) === pending) { this.pending.delete(value.id); this.pendingRequests.delete(value.id) } })
      this.pending.set(value.id, pending)
      this.pendingRequests.set(value.id, fingerprint)
    }
    return { id: value.id }
  }
  @Remote
  async observe(input: WebIdInput): Promise<WebRunRecord> { this.owner(); return this.controller.observe(idSchema.parse(input).id) }
  @Remote
  async cancel(input: WebIdInput): Promise<WebRunRecord> { this.owner(); return this.controller.cancel(idSchema.parse(input).id) }
  @Remote
  async abandon(input: WebAbandonInput): Promise<WebRunRecord> {
    this.owner()
    const value = abandonSchema.parse(input)
    return this.controller.abandon(value.id, value.expectedRevision, value.acknowledgeUnknown)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarChatGptWebControl: WebControl } }
