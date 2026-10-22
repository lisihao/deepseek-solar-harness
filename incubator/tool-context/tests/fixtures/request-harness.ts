/**
 * Isolated rc.2 AgentLoop/PTC fixture used by tool-context integration tests.
 *
 * The fixture mounts published Cordis, AgentLoop, SessionQuery and ToolRuntime
 * services in a new Context. Its adapter and PTC substrate are deliberately
 * in-memory: no provider, Host profile, browser, subprocess, or user session
 * participates in a test.
 */
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentSetup } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import ToolRuntime from '@deepseek-ai/dsh-tools'

export type ResponsePlan = readonly StreamChunk[] | ((request: GenerateOptions) => readonly StreamChunk[])

/** Captures every AgentLoop-built request without opening a provider connection. */
export class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly plan: ResponsePlan[],
    private readonly options: { readonly inHistorySystemPrompt?: boolean } = {},
  ) {
    super()
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      ...(this.options.inHistorySystemPrompt === true ? { systemPromptUpdate: 'in-history' as const } : {}),
    }
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.plan.shift()
    if (response === undefined) throw new Error('tool-context fixture fake-model plan is exhausted')
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

/** One complete direct tool-call response followed by the caller's next step. */
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

interface FixtureBindingNamespace {
  readonly global: string
  readonly functions: Record<string, (args: unknown) => Promise<unknown>>
}

interface FixturePtcRequest {
  readonly program: string
  readonly bindings: readonly FixtureBindingNamespace[]
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly timeoutMs?: number | null
}

interface FixturePtcSpec extends FixturePtcRequest {
  readonly cwd: string
  readonly timeoutMs: number | null
}

export interface PtcAction {
  /** One or more published run_code bridge bindings to invoke in source order. */
  readonly name?: string
  readonly arguments?: unknown
  readonly calls?: readonly { readonly name: string; readonly arguments: unknown }[]
}

/**
 * A thin, deterministic PTC substrate. ToolRuntime still constructs the
 * published run_code transport, bindings, scheduler, guards and durable PTC
 * dispatch records; this class only replaces process execution with one named
 * binding call chosen by the test.
 */
export class CapturingPtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  readonly programFormat = 'function-body' as const
  readonly runs: FixturePtcRequest[] = []
  readonly bindingCalls: { name: string; arguments: unknown }[] = []

  constructor(private readonly actions: PtcAction[]) {}

  get executionInstructions(): string {
    return 'Fixture PTC runtime: the test controls one declared tools binding per run_code request.'
  }

  get sandboxMode(): undefined {
    return undefined
  }

  get timeout(): undefined {
    return undefined
  }

  resolve(request: FixturePtcRequest): FixturePtcSpec {
    this.runs.push(request)
    return {
      ...request,
      cwd: request.cwd ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? null,
    }
  }

  async run(spec: FixturePtcSpec): Promise<{ logs: string[]; value?: unknown; error?: { kind: 'exception'; message: string } }> {
    const action = this.actions.shift()
    if (!action) return { logs: [], error: { kind: 'exception', message: 'tool-context fixture PTC action plan is exhausted' } }
    const tools = spec.bindings.find(binding => binding.global === 'tools')
    const calls = action.calls ?? (action.name === undefined
      ? []
      : [{ name: action.name, arguments: action.arguments }])
    if (calls.length === 0) return { logs: [], error: { kind: 'exception', message: 'tool-context fixture PTC action has no binding calls' } }
    try {
      const values: unknown[] = []
      for (const call of calls) {
        const invoke = tools?.functions[call.name]
        if (invoke === undefined) throw new Error(`tool-context fixture binding is unavailable: ${call.name}`)
        this.bindingCalls.push({ name: call.name, arguments: call.arguments })
        values.push(await invoke(call.arguments))
      }
      return { logs: [], value: values.length === 1 ? values[0] : values }
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async release(_owner: object): Promise<void> {}
}

/**
 * Published SessionQueryEngine supplies the read-only listEvents/readEvent
 * implementation that tool-context uses. Search methods are irrelevant to
 * this fixture and fail loudly if a test accidentally reaches them.
 */
class FixtureSessionQuery extends SessionQueryEngine {
  override searchSessions(..._args: Parameters<SessionQueryEngine['searchSessions']>): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.reject(new Error('tool-context fixture does not provide session search'))
  }

  override searchEvents(..._args: Parameters<SessionQueryEngine['searchEvents']>): ReturnType<SessionQueryEngine['searchEvents']> {
    return Promise.reject(new Error('tool-context fixture does not provide event search'))
  }
}

export interface LoopAgentHandle {
  readonly agent: any
  dispose(): Promise<void>
}

export interface RequestHarness {
  readonly ctx: Context
  readonly adapter: CapturingAdapter
  readonly ptc: CapturingPtcRuntime
  readonly flushes: { count: number }
  readonly handles: LoopAgentHandle[]
  cleanup(): Promise<void>
}

export interface RequestHarnessOptions {
  readonly ptcActions?: PtcAction[]
  /** Make the fake route read later system messages, exercising series repair. */
  readonly inHistorySystemPrompt?: boolean
}

async function publishedLoopSupport(): Promise<{ SystemPrompt: any; SessionProjectionRegistry: any }> {
  // Resolve the peer services from AgentLoop's published package boundary so
  // Cordis sees the exact constructor identities AgentLoop declares.
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

/** Mount the published AgentLoop prerequisite spine in one isolated Context. */
export async function mountRequestHarness(
  plan: ResponsePlan[],
  options: RequestHarnessOptions = {},
): Promise<RequestHarness> {
  const ctx = new Context()
  const { SystemPrompt, SessionProjectionRegistry } = await publishedLoopSupport()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FixtureSessionQuery)
  const ptc = new CapturingPtcRuntime(options.ptcActions ?? [])
  ctx.provide('ptcRuntime', ptc)
  ctx.provide('workingDirectory', {
    async ensure(_agent: unknown, signal?: AbortSignal): Promise<string> {
      signal?.throwIfAborted()
      return process.cwd()
    },
    get(): string {
      return process.cwd()
    },
  })
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new CapturingAdapter(plan, { inHistorySystemPrompt: options.inHistorySystemPrompt })
  ctx.llm.registerAdapter(['tool-context-fixture'], adapter)
  const flushes = { count: 0 }
  ctx.on('session/flush', async () => {
    flushes.count += 1
  })
  const handles: LoopAgentHandle[] = []

  return {
    ctx,
    adapter,
    ptc,
    flushes,
    handles,
    async cleanup(): Promise<void> {
      await Promise.allSettled(handles.splice(0).reverse().map(handle => handle.dispose()))
      await ctx.fiber.dispose()
    },
  }
}

export interface CreateLoopAgentOptions {
  readonly seed?: readonly SessionEvent[]
  readonly setup?: AgentSetup
  /** PTC is the default; false preserves the published native presentation. */
  readonly ptc?: boolean
}

/** Create a real published AgentLoop agent inside this fixture's isolated Context. */
export async function createLoopAgent(
  harness: RequestHarness,
  id: string,
  options: CreateLoopAgentOptions = {},
): Promise<LoopAgentHandle> {
  const setup: AgentSetup = async (agentCtx, agent) => {
    if (options.ptc !== false) agentCtx.tools.presentAs('ptc')
    return await options.setup?.(agentCtx, agent)
  }
  const handle = await harness.ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'tool-context-fixture', model: 'fixture-model' },
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    setup,
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
