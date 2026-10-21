/**
 * Framework-neutral, in-memory request harness for published rc.2 services.
 *
 * It creates a fresh Cordis Context and mounts the published AgentLoop spine.
 * The only model boundary is CapturingAdapter, so callers can observe an actual
 * AgentLoop-built request without a provider call or any interaction with an
 * already-running Desktop Host.
 */
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as OfficialSkillTool from '@deepseek-ai/dsh-tool-skill'

export type ResponsePlan = readonly StreamChunk[] | ((request: GenerateOptions) => readonly StreamChunk[])

export class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly plan: ResponsePlan[]) {
    super()
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.plan.shift()
    if (response === undefined) throw new Error('request-harness fake-model plan is exhausted')
    for (const chunk of typeof response === 'function' ? response(request) : response) {
      request.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** A small normal completion response for a fake model plan. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One complete model tool-call response followed by the normal continuation step. */
export function toolCallResponse(call: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(call)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export interface LoopAgentHandle {
  readonly agent: any
  dispose(): Promise<void>
}

export interface RequestHarness {
  readonly ctx: Context
  readonly adapter: CapturingAdapter
  readonly flushes: { count: number }
  readonly handles: LoopAgentHandle[]
  cleanup(): Promise<void>
}

async function publishedLoopSupport(): Promise<{ SystemPrompt: any; SessionProjectionRegistry: any }> {
  // Resolve rc.2 peer services from AgentLoop's own published package boundary.
  // The fixture does not copy or simulate Session projection/request construction.
  const requireFromLoop = createRequire(
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop/package.json'),
  )
  const [systemPrompt, projections] = await Promise.all([
    import(requireFromLoop.resolve('@deepseek-ai/dsh-system-prompt')),
    import(requireFromLoop.resolve('@deepseek-ai/dsh-session-projection')),
  ])
  return {
    SystemPrompt: systemPrompt.default,
    SessionProjectionRegistry: projections.default,
  }
}

/** Mount the published AgentLoop prerequisite spine in a new, isolated Context. */
export async function mountRequestHarness(plan: ResponsePlan[]): Promise<RequestHarness> {
  const ctx = new Context()
  const { SystemPrompt, SessionProjectionRegistry } = await publishedLoopSupport()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SkillRegistry)
  ctx.provide('workingDirectory', {
    async ensure(_agent: unknown, signal?: AbortSignal): Promise<string> {
      signal?.throwIfAborted()
      return process.cwd()
    },
    get(): string {
      return process.cwd()
    },
  })
  await ctx.plugin(OfficialSkillTool, {})
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new CapturingAdapter(plan)
  ctx.llm.registerAdapter(['skill-context-fixture'], adapter)
  const flushes = { count: 0 }
  ctx.on('session/flush', async () => {
    flushes.count += 1
  })
  const handles: LoopAgentHandle[] = []

  return {
    ctx,
    adapter,
    flushes,
    handles,
    async cleanup(): Promise<void> {
      await Promise.allSettled(handles.splice(0).reverse().map(handle => handle.dispose()))
      await ctx.fiber.dispose()
    },
  }
}

/** Create a real published AgentLoop agent inside this fixture's isolated Context. */
export async function createLoopAgent(
  harness: RequestHarness,
  id: string,
  options: { readonly seed?: readonly SessionEvent[]; readonly setup?: (agentCtx: any) => void } = {},
): Promise<LoopAgentHandle> {
  const handle = await harness.ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'skill-context-fixture', model: 'fixture-model' },
    ...options.seed === undefined ? {} : { seed: options.seed },
    ...options.setup === undefined ? {} : { setup: options.setup },
  }) as LoopAgentHandle
  harness.handles.push(handle)
  return handle
}

/** Drive one normal user turn to real AgentLoop quiescence. */
export async function followLoopAgent(agent: LoopAgentHandle, text: string): Promise<void> {
  agent.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.agent.whenIdle()
}

export interface IsolatedHarnessRun {
  readonly requestCount: number
  readonly messageCounts: readonly number[]
  readonly sourceKinds: readonly (readonly (string | null)[])[]
  readonly toolNames: readonly (readonly string[])[]
  readonly flushCount: number
}

/**
 * One reusable built-mode-friendly smoke path. The callback may mount a plugin
 * on this new Context; no service, AgentRegistry, or Session is shared with a
 * running Host. Its return is JSON-serializable evidence only.
 */
export async function runIsolatedRequestHarness(options: {
  readonly apply: (ctx: Context) => void | Promise<void>
  readonly configure?: (ctx: Context) => void | Promise<void>
  readonly plan?: ResponsePlan[]
  readonly input?: string
  readonly agentId?: string
}): Promise<IsolatedHarnessRun> {
  const harness = await mountRequestHarness(options.plan ?? [textResponse('isolated fixture response')])
  try {
    await options.configure?.(harness.ctx)
    await options.apply(harness.ctx)
    const agent = await createLoopAgent(harness, options.agentId ?? 'isolated-request-harness')
    await followLoopAgent(agent, options.input ?? 'isolated fixture request')
    return {
      requestCount: harness.adapter.requests.length,
      messageCounts: harness.adapter.requests.map(request => request.messages.length),
      sourceKinds: harness.adapter.requests.map(request => request.messages.map(message =>
        'source' in message && message.source !== undefined
          ? (message.source as { kind?: string }).kind ?? null
          : null)),
      toolNames: harness.adapter.requests.map(request => request.tools?.map(tool => tool.name) ?? []),
      flushCount: harness.flushes.count,
    }
  } finally {
    await harness.cleanup()
  }
}
