import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelSelection as SessionModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

import { INSIGHT_LLM_MODEL, INSIGHT_LLM_NAME } from './conversation-adapter.js'
import { WEB_LLM_PROVIDER } from './llm-adapter.js'

/** Public preset identity used by the Insight Analysis model route. */
export const INSIGHT_PRESET_ID = 'solar-insight-analysis' as const

const insightSelection: SessionModelSelection = Object.freeze({
  provider: WEB_LLM_PROVIDER,
  model: INSIGHT_LLM_MODEL,
})

type AgentPresetScope = Pick<AgentPresetRegistry, 'composedPreset' | 'register'>

function sessionEvents(session: Pick<Session, 'ownEvents'>): readonly SessionEvent[] {
  return typeof session.ownEvents === 'function' ? session.ownEvents() : []
}

function latestSelection(session: Pick<Session, 'ownEvents'>): SessionModelSelection | undefined {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'model/selection') return event.data
  }
  return undefined
}

function hasRequestHeader(session: Pick<Session, 'requestHeader' | 'ownEvents'>): boolean {
  if (typeof session.requestHeader === 'function') return session.requestHeader() !== undefined
  return sessionEvents(session).some(event => event.type === 'request/header')
}

function sameSelection(left: SessionModelSelection | undefined, right: SessionModelSelection): boolean {
  return left?.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * Read the durable preset selection without relying on private registry state.
 * The latest selection event is the canonical projection; the header and the
 * test/runtime metadata are only fallback creation facts.
 */
function sessionPreset(session: Pick<Session, 'header' | 'ownEvents'>): string | undefined {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  const metadata = (session as Session & { readonly meta?: { readonly agentPreset?: unknown } }).meta
  if (typeof metadata?.agentPreset === 'string') return metadata.agentPreset
  return session.header?.agentPreset
}

function isInsightAgent(agent: Agent, registry: AgentPresetScope): boolean {
  const composed = registry.composedPreset(agent.ctx)
  if (composed !== undefined) return composed === INSIGHT_PRESET_ID
  return sessionPreset(agent.session) === INSIGHT_PRESET_ID
}

function routeInsight(config: LlmCallConfig): LlmCallConfig {
  return { ...config, provider: insightSelection.provider, model: insightSelection.model }
}

/**
 * Register the public Insight preset and bind its first request to the public
 * model route. The returned disposer is also registered with the owning
 * Cordis effect, so a plugin unload removes the preset and Host listener.
 */
export async function installInsightPreset(ctx: Context): Promise<() => Promise<void>> {
  const registry = ctx.agentPresets as AgentPresetScope | undefined
  if (registry === undefined) throw new Error('INSIGHT_PRESET_REGISTRY_UNAVAILABLE: Agent preset registry is required.')

  const unregisterPreset = await registry.register({
    id: INSIGHT_PRESET_ID,
    name: INSIGHT_LLM_NAME,
    plugins: [],
  })

  const boundAgents = new WeakSet<object>()
  const requestDisposers = new Set<() => boolean>()
  const onCreated = ({ agent }: { readonly agent: Agent }): undefined => {
    if (boundAgents.has(agent) || !isInsightAgent(agent, registry)) return undefined
    boundAgents.add(agent)

    const session = agent.session
    const firstRequestAlreadyLogged = hasRequestHeader(session)
    const pending = latestSelection(session)
    if (!firstRequestAlreadyLogged && pending === undefined) {
      session.append('model/selection', insightSelection)
    }
    if (firstRequestAlreadyLogged) return undefined

    const unregisterRequest = agent.ctx.on('agent/request', async (_payload, next) => {
      // A user selection made after creation is durable and wins over the
      // default. The request/header check also makes this a first-request-only
      // binding, leaving every later request to the Host selection waterfall.
      if (!isInsightAgent(agent, registry)) return next()
      if (hasRequestHeader(session)) return next()
      const config = await next()
      if (hasRequestHeader(session)) return config
      const selected = latestSelection(session)
      if (selected !== undefined && !sameSelection(selected, insightSelection)) return config
      return routeInsight(config)
    }, { prepend: true })
    requestDisposers.add(unregisterRequest)
    return undefined
  }

  const unregisterCreated = ctx.on('agent/created', onCreated, { global: true })
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    unregisterCreated()
    for (const unregisterRequest of requestDisposers) unregisterRequest()
    requestDisposers.clear()
    await unregisterPreset()
  }
  ctx.effect(() => dispose, 'chatgpt-web.insight-preset')
  return dispose
}
