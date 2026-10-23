import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { createChatRecall, type RecallConfig, type RecallServices } from './recall.js'
export const name = 'solar-hindsight-chat-recall'
export const inject = ['mnemonRemote', 'workspaceRegistry']
export const Config: z<RecallConfig> = z.object({
  timeoutMs: z.number().step(1).min(100).max(120000).default(60000),
  resultLimit: z.number().step(1).min(1).max(10).default(2),
  maxContextCharacters: z.number().step(1).min(1000).max(32000).default(12000),
})
export function apply(ctx: Context, config: RecallConfig): void {
  const remote = ctx.get('mnemonRemote') as { read: RecallServices['read'] }
  const registry = ctx.get('workspaceRegistry') as { list(): ReturnType<RecallServices['workspaces']> }
  const lifetime = new AbortController()
  const recall = createChatRecall({ read: (operation,payload,signal) => remote.read(operation,payload,signal), workspaces: () => registry.list() }, config, lifetime.signal)
  ctx.effect(() => () => lifetime.abort(new Error('Chat recall plugin disposed')))
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.signal.aborted) return decision
    const message = await recall(payload.agent, decision.messages, payload.signal)
    if (message === undefined) return decision
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
