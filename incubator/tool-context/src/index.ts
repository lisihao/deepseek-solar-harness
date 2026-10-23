import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, renderToolsSdk, type PtcDispatchEventData } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { catalogRevision, searchTools, type CatalogEntry, type CatalogLimits } from './catalog.js'
import { LOAD_NAME, SEARCH_NAME, makeReceipt, parseReceipt, renderSelection, validSelection, type LoadReceipt, type ProgramFormat, type SelectedTool, type SelectionLimits } from './receipts.js'

export const name = 'tool-context'
export const inject = ['tools', 'systemPrompt', 'sessions', 'sessionQuery']
export interface Config extends CatalogLimits, SelectionLimits {}
export const DEFAULT_CONFIG: Config = { maxResults: 8, maxDescriptionChars: 240, maxSearchBytes: 8192, maxLoadedTools: 16, maxLoadedBytes: 32768 }
export const Config: z<Config> = z.object({
  maxResults: z.number().min(1).max(20).default(8),
  maxDescriptionChars: z.number().min(40).max(500).default(240),
  maxSearchBytes: z.number().min(1024).max(32768).default(8192),
  maxLoadedTools: z.number().min(1).max(64).default(16),
  maxLoadedBytes: z.number().min(8192).max(262144).default(32768),
})

interface State {
  hydrated?: Promise<void>
  latest?: { seq: number; receipt: LoadReceipt }
  pendingFlush: boolean
  pendingSdk?: { text: string; digest: string }
  pendingPrompt?: string
}

// Cooperative prompt plugins may reindent the SDK or rewrite generated JSDoc.
// Identify its executable/type contract independently of those one-line docs;
// quoted names/values, declaration lines and the usage preamble remain exact.
function sameSdkText(expected: string, actual: string): boolean {
  const comparable = (text: string): string | undefined => {
    const trimmed = text.trim()
    const start = trimmed.lastIndexOf('\n```ts\n')
    if (start === -1 || !trimmed.endsWith('\n```')) return undefined
    const lines = (value: string) => value.split('\n').map(line => line.replace(/^[ \t]+/, ''))
    // The public renderer emits descriptions as complete, single-line JSDoc
    // comments. Restrict this exemption to the final declaration fence: prose,
    // examples, incomplete comments and comment-like schema literals retain
    // their original comparison semantics.
    const prefix = lines(trimmed.slice(0, start)).join('\n')
    const declaration = lines(trimmed.slice(start + '\n```ts\n'.length, -'\n```'.length))
      .filter(line => !(line.startsWith('/** ') && line.endsWith(' */') && !line.slice(4, -3).includes('*/'))).join('\n')
    return `${prefix}\n\`\`\`ts\n${declaration}\n\`\`\``
  }
  const left = comparable(expected)
  return left !== undefined && left === comparable(actual)
}

async function waitForCommit(committed: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void committed.then(value => { signal.removeEventListener('abort', abort); resolve(value) })
  })
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const limits = { ...DEFAULT_CONFIG, ...config }
  for (const [key, min, max] of [['maxResults', 1, 20], ['maxDescriptionChars', 40, 500], ['maxSearchBytes', 1024, 32768], ['maxLoadedTools', 1, 64], ['maxLoadedBytes', 8192, 262144]] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error(`TOOL_CONTEXT_CONFIG_INVALID: ${key} must be an integer from ${min} to ${max}`)
  }
  const states = new WeakMap<Session, State>()
  const assembled = new WeakMap<Agent, { digest: string; state: State; wireTools: string }>()
  // Some installed prompt wrappers catch assemble errors and return an empty
  // composition. Retain the original failure until the admission boundary,
  // outside that wrapper, rather than letting a stripped request proceed.
  const assemblyErrors = new WeakMap<Agent, unknown>()
  const formats = new WeakMap<Agent, ProgramFormat>()
  // A binding promise may settle before its asynchronous PTC log copy. Keep
  // accepted outcomes only for composing sibling loads in that same program;
  // admission still reads committed session receipts, never this staging map.
  const staged = new WeakMap<Agent, { rootCallId: string; receipt: LoadReceipt; committed: Promise<boolean> }>()
  const committing = new WeakMap<Session, { callId: string; receipt: LoadReceipt; resolve: (accepted: boolean) => void }>()
  const stateFor = (session: Session): State => {
    let state = states.get(session)
    if (!state) { state = { pendingFlush: false }; states.set(session, state) }
    return state
  }
  const remember = (session: Session, seq: number, data: PtcDispatchEventData, pending: boolean) => {
    const receipt = parseReceipt(data, session.id)
    if (!receipt) return
    const state = stateFor(session)
    if (!state.latest || seq > state.latest.seq) state.latest = { seq, receipt }
    if (pending) state.pendingFlush = true
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/ptc-dispatch') {
      remember(session, event.seq, event.data, true)
      const pending = committing.get(session)
      if (pending?.callId === event.data.subCallId) {
        pending.resolve(JSON.stringify(parseReceipt(event.data, session.id)) === JSON.stringify(pending.receipt))
        committing.delete(session)
      }
    }
  })
  const hydrate = async (session: Session, signal?: AbortSignal): Promise<State> => {
    const state = stateFor(session)
    if (!state.hydrated) {
      state.hydrated = (async () => {
        const records = await ctx.sessionQuery.listEvents(session.id)
        for (const record of [...records].reverse()) {
          signal?.throwIfAborted()
          if (record.type !== 'tool/ptc-dispatch') continue
          const { target } = await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: record.seq, before: 0, after: 0 })
          if (target.type === 'tool/ptc-dispatch' && parseReceipt(target.data, session.id)) { remember(session, target.seq, target.data, false); break }
        }
      })()
      try { await state.hydrated } catch (error) { state.hydrated = undefined; throw error }
    } else await state.hydrated
    return state
  }
  const catalog = (agent?: Agent): CatalogEntry[] => ctx.tools.schemas(agent).filter(schema => schema.name !== 'run_code').map(schema => {
    const definition = ctx.tools.get(schema.name, agent)
    if (!definition) throw new Error(`TOOL_CONTEXT_REGISTRY_CHANGED: ${schema.name} disappeared during catalog assembly`)
    return { ...schema, output: definition.output.schema }
  })
  const selection = (state: State, entries: CatalogEntry[], format: ProgramFormat): SelectedTool[] => {
    const receipt = state.latest?.receipt
    if (receipt) {
      if (receipt.registryRevision !== catalogRevision(entries.filter(entry => entry.name !== SEARCH_NAME && entry.name !== LOAD_NAME))) return []
      // A changed/restricted declaration cannot leak through an old receipt.
      const selected = validSelection(entries, receipt.selected, limits, format)
      if (selected.length !== receipt.selected.length || receipt.selected.some(item => item.name === SEARCH_NAME || item.name === LOAD_NAME)) return []
      if (receipt.requested.some(name => !selected.some(item => item.name === name))) return []
      if (Buffer.byteLength(renderSelection(entries, selected, format)) !== receipt.selectedSdkBytes) return []
      return selected
    }
    return []
  }
  const search = defineTool({
    name: SEARCH_NAME,
    description: 'Find caller-allowed tools by keywords or exact name. Returns bounded names and summaries, never executes them. Use nextOffset for the next page, then solar_tool_load for complete declarations.',
    parameters: { query: { type: 'string', required: true }, offset: { type: 'integer', description: 'Previous nextOffset for the same query, default 0.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) { exec.signal.throwIfAborted(); return searchTools(catalog(exec.agent).filter(entry => entry.name !== SEARCH_NAME && entry.name !== LOAD_NAME), args.query, args.offset ?? 0, limits) as never },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '按需查找工具' }),
  })
  const load = defineTool({
    name: LOAD_NAME,
    description: 'Load complete argument/output declarations for exact tool names into the NEXT request. Does not execute those tools or grant permissions. Receipt reports retained descriptions and evictions; reload evicted names when needed.',
    parameters: { names: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent || !exec.parent || !formats.has(exec.agent)) throw new Error('TOOL_CONTEXT_PTC_REQUIRED: load descriptions through the caller’s normal TypeScript run_code binding')
      const state = await hydrate(exec.agent.session, exec.signal)
      exec.signal.throwIfAborted()
      const format = formats.get(exec.agent)!
      const sibling = staged.get(exec.agent)
      if (sibling?.rootCallId === exec.rootCallId) {
        const accepted = await waitForCommit(sibling.committed, exec.signal)
        if (!accepted) throw new Error('TOOL_CONTEXT_RECEIPT_NOT_RECORDED: a previous load in this program has no matching accepted log receipt')
      }
      exec.signal.throwIfAborted()
      const entries = catalog(exec.agent)
      const prior = sibling?.rootCallId === exec.rootCallId ? sibling.receipt.selected : selection(state, entries, format)
      return makeReceipt(exec.agent.session.id, entries, prior, args.names, limits, format) as never
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '加载工具说明' }),
  })
  ctx.effect(() => ctx.tools.register(search))
  ctx.effect(() => ctx.tools.register(load))
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || !exec.parent || exec.name !== LOAD_NAME || result.isError) return
    const receipt = parseReceipt({ name: exec.name, arguments: exec.arguments, content: result.content, isError: false, rootCallId: exec.rootCallId, parentCallId: exec.rootCallId, subCallId: exec.callId }, exec.agent.session.id)
    if (receipt) {
      const committed = new Promise<boolean>(resolve => committing.set(exec.agent!.session, { callId: exec.callId, receipt, resolve }))
      staged.set(exec.agent, { rootCallId: exec.rootCallId, receipt, committed })
    }
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    try {
      const assembly = await next()
      if (!assembly.tools.some(tool => tool.name === 'run_code')) {
        if (ctx.tools.schemas(context.scope).some(tool => tool.name === 'run_code')) {
          throw new Error('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED: the PTC caller still has run_code but the prompt composition removed its transport; no request was admitted')
        }
        // These helpers are an owned PTC presentation contribution, not two new
        // Native wire functions. Existing Native tool declarations stay exact.
        assembly.tools = assembly.tools.filter(tool => !(tool.name === SEARCH_NAME && ctx.tools.get(SEARCH_NAME, context.scope) === search) && !(tool.name === LOAD_NAME && ctx.tools.get(LOAD_NAME, context.scope) === load))
        if (agent) { assembled.delete(agent); formats.delete(agent); assemblyErrors.delete(agent) }
        return assembly
      }
      const sections = assembly.sections.filter(section => section.name === 'tools:sdk')
      if (sections.length !== 1) throw new Error('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED: TypeScript PTC requires one cooperative tools:sdk section; complete prompts are not supported')
      if (context.scope !== agent && context.scope !== undefined) throw new Error('TOOL_CONTEXT_SCOPE_UNSUPPORTED: this PTC assembly has no matching agent scope')
      const entries = catalog(agent)
      if (ctx.tools.get(SEARCH_NAME, agent) !== search || ctx.tools.get(LOAD_NAME, agent) !== load) throw new Error('TOOL_CONTEXT_DISCOVERY_UNAVAILABLE: caller policy must allow solar_tool_search and solar_tool_load; no allowlist was changed')
      const section = sections[0]!
      const format = (['function-body', 'repl'] as const).find(value => sameSdkText(renderToolsSdk([...entries], value), section.text))
      if (!format) throw new Error('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED: SDK does not match the published TypeScript renderer; original declarations were not guessed')
      const state: State = agent ? await hydrate(agent.session, context.signal) : { pendingFlush: false }
      const chosen = selection(state, entries, format)
      const text = renderSelection(entries, chosen, format)
      if (Buffer.byteLength(renderSelection(entries, [], format)) > 8192) throw new Error('TOOL_CONTEXT_BOOTSTRAP_TOO_LARGE: discovery declarations exceed 8192 UTF-8 bytes')
      section.text = text
      section.interpolate = false
      if (agent) {
        const digest = createHash('sha256').update(text).digest('hex')
        state.pendingSdk = { text, digest }
        state.pendingPrompt = renderPrompt(assembly)
        formats.set(agent, format)
        assembled.set(agent, { digest, state, wireTools: JSON.stringify(assembly.tools) })
        assemblyErrors.delete(agent)
      }
      return assembly
    } catch (error) {
      if (agent) assemblyErrors.set(agent, error)
      throw error
    }
  }, { prepend: true })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (assemblyErrors.has(agent)) throw assemblyErrors.get(agent)
    const current = assembled.get(agent)
    if (!current) {
      if (ctx.tools.schemas(agent).some(tool => tool.name === 'run_code')) {
        throw new Error('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED: the PTC caller has no verified discovery composition; no request was admitted')
      }
      return decision
    }
    // The verification assembly may re-evaluate dynamic providers. It must
    // not replace the first assembly that AgentLoop will actually commit.
    const requestPrompt = current.state.pendingPrompt
    const requestSdk = current.state.pendingSdk?.text
    signal.throwIfAborted()
    {
      // This public reassembly catches stable post-waterfall changes (including
      // complete:true), and retained errors catch an inner failure swallowed by
      // an outer wrapper. It does not replace AgentLoop's first assembly.
      const final = await ctx.systemPrompt.assemble({ agent, scope: agent, signal })
      if (assemblyErrors.has(agent)) throw assemblyErrors.get(agent)
      const sections = final.sections.filter(section => section.name === 'tools:sdk')
      if (sections.length !== 1 || requestSdk === undefined || !sameSdkText(requestSdk, sections[0]!.text)
        || !renderPrompt(final).trim() || JSON.stringify(final.tools) !== current.wireTools) {
        throw new Error('TOOL_CONTEXT_PRESENTATION_UNSUPPORTED: a complete system prompt displaced the discovery SDK; no optimized request was admitted')
      }
    }
    if (current.state.pendingFlush) {
      let persisted: boolean
      try { persisted = await ctx.sessions.flush(agent.session) } catch (cause) { throw new Error('TOOL_CONTEXT_FLUSH_FAILED: accepted loader receipt is not confirmed durable; request stopped', { cause }) }
      if (!persisted) throw new Error('TOOL_CONTEXT_FLUSH_FAILED: accepted loader receipt is not confirmed durable; request stopped')
      current.state.pendingFlush = false
    }
    signal.throwIfAborted()
    // Normalize the complete system prompt, including other dynamic sections:
    // otherwise an in-history update repeats the SDK when any section changes.
    // This read also handles cold resumes and multiple older effective nodes.
    const systemTexts = agent.session.deriveMessages().filter(message => message.role === 'system').map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')).filter(Boolean)
    const changed = systemTexts.length !== 1 || systemTexts[0] !== requestPrompt
    return changed ? { ...decision, startsRequestSeries: true } : decision
  }, { prepend: true })
}
