import type { HostAgent, HostContextShape } from './contracts.ts'
import type { ResolvedConfig } from './config.ts'
import type { RuntimeMemoryController } from './runtime-memory.ts'

export const GUIDANCE_SECTION_NAME = 'mnemon:routing'
export const RUNTIME_MEMORY_CONTEXT_NAME = 'mnemon:runtime-memory'
export const ROUTING_GUIDANCE = 'Use memory only by need. For substantial project records, search active Mnemon Documents before deep recall. Call mnemon_recall when durable history may matter or an exact prior detail is missing; never infer a missing historical rule. New explicit reusable facts normally go to mnemon_runtime_memory. A write completes only with a tool receipt.'
const RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE = 'mnemon_runtime_memory_literal_open_braces'
const LITERAL_OPEN_BRACES = '{{'

interface SystemPromptRegistry {
  section?: (value: { name: string; order: number; text: string | (() => string) }) => unknown
  context?: (value: { name: string; order: number; text: string | (() => string) }) => unknown
  variable?: (name: string, provider: () => string) => unknown
}

function systemPrompt(ctx: HostContextShape): SystemPromptRegistry | undefined {
  return ctx.get('systemPrompt') as SystemPromptRegistry | undefined
}

function scopedSystemPrompt(agent: HostAgent): SystemPromptRegistry | undefined {
  return agent.ctx.get?.('systemPrompt') as SystemPromptRegistry | undefined
}

function runtimeMemoryPromptText(runtimeMemory: RuntimeMemoryController): string {
  return runtimeMemory.contextText().replaceAll(
    LITERAL_OPEN_BRACES,
    `{{${RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE}}}`,
  )
}

export function registerGuidance(ctx: HostContextShape, config?: Pick<ResolvedConfig, 'routingGuidance'>): void {
  systemPrompt(ctx)?.section?.({
    name: GUIDANCE_SECTION_NAME,
    order: 150,
    text: () => config?.routingGuidance === false ? '' : ROUTING_GUIDANCE,
  })
}

/** Project the latest committed USER.md/MEMORY.md as DSH's durable runtime-context snapshot. */
export function registerRuntimeMemoryContext(ctx: HostContextShape, runtimeMemory: RuntimeMemoryController): void {
  const prompt = systemPrompt(ctx)
  // Runtime Memory is quoted user data, so every interpolation opener must be
  // restored through a non-recursive variable substitution instead of parsed.
  prompt?.variable?.(RUNTIME_MEMORY_LITERAL_OPEN_BRACES_VARIABLE, () => LITERAL_OPEN_BRACES)
  prompt?.context?.({
    name: RUNTIME_MEMORY_CONTEXT_NAME,
    order: 145,
    text: () => runtimeMemoryPromptText(runtimeMemory),
  })
}

/** Shadow the global fallback with the current Agent workspace's hot memory. */
export function registerAgentRuntimeMemoryContext(agent: HostAgent, runtimeMemory: () => RuntimeMemoryController): () => void {
  const dispose = scopedSystemPrompt(agent)?.context?.({
    name: RUNTIME_MEMORY_CONTEXT_NAME,
    order: 145,
    text: () => runtimeMemoryPromptText(runtimeMemory()),
  })
  return typeof dispose === 'function' ? dispose as () => void : () => {}
}
