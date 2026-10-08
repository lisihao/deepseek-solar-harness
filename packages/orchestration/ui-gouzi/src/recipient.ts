/** Host-owned qualification and direct-dispatch guard for kennel recipients. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { PhysicalOperatorId } from '@deepseek-ai/dsh-physical-operator'
import { GouziId, type OrchestrationRecipientResolver, type OrchestrationGouziRecipientV1 } from '@deepseek-ai/dsh-orchestration'
import type {} from '@deepseek-ai/dsh-tools'
import { decodeKennelMessage, type KennelRecipient } from './recipient-message.ts'

/**
 * Read the newest real user message, bounded by the current logical turn.
 * @param events - ordered durable events.
 * @returns explicit recipient in that message, if present.
 */
export function currentKennelRecipient(events: readonly SessionEvent[]): KennelRecipient | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' || event?.type === 'turn/end') return undefined
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return decodeKennelMessage(text).recipient
  }
  return undefined
}

/** The Host confirms registration again for every directed start. */
export class GouziRecipientResolver extends Service implements OrchestrationRecipientResolver {
  constructor(ctx: Context, readonly automaticDispatch = false) { super(ctx, 'orchestrationRecipients') }

  async resolve(events: readonly SessionEvent[]): Promise<OrchestrationGouziRecipientV1 | undefined> {
    const selected = currentKennelRecipient(events)
    if (selected === undefined) return undefined
    const control = this.ctx.get('orchestrations')?.gouzi
    if (control === undefined) throw new Error('当前编排服务没有狗子执行注册，无法启动点名任务')
    const confirm = async (): Promise<void> => {
      const member = (await control.list()).members.find(member => String(member.gouziId) === selected.gouziId)
      if (member === undefined) throw new Error('点名的狗子已不存在，请重新选择')
      if (member.generation !== selected.generation) throw new Error('点名的狗子已换代，请重新选择')
      if (member.membership !== 'enabled') throw new Error('点名的狗子尚未启用，无法执行任务')
    }
    await confirm()
    const directory = (await control.executionOperators()).find(entry =>
      String(entry.gouziId) === selected.gouziId && entry.generation === selected.generation)
    const operatorIds = directory?.operators.filter(operator => operator.available)
      .map(operator => PhysicalOperatorId(operator.operatorId)) ?? []
    if (operatorIds.length === 0) throw new Error('点名的狗子没有可用的实际执行入口，请检查注册和登录状态')
    await confirm()
    return { gouziId: GouziId(selected.gouziId), generation: selected.generation, operatorIds }
  }
}

/**
 * Install a guard only when the optional tool runtime is present.
 * @param ctx - owning Host plugin context.
 */
export function installKennelRecipientGuard(ctx: Context): void {
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.guard((exec) => {
      if (exec.agent === undefined) return undefined
      const args = exec.arguments as { action?: unknown } | null
      const delegation = exec.delegation
      const dispatch = delegation !== undefined
        && (delegation.actions === undefined || delegation.actions.some(action => action === args?.action))
      if (!dispatch) return undefined
      try {
        if (currentKennelRecipient(exec.agent.session.events) === undefined) return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return '本轮已点名狗子，请通过 orchestration 的标准 TaskGraph 节点执行，不能直接派发或替换执行者'
    })
  })
}
