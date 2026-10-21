import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDeveloperMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SKILL_SEARCH_OPTIONS, searchSkills, type SkillSearchOptions } from './search.js'

export const name = 'skill-context'
export const inject = ['agents', 'tools', 'skills', 'workingDirectory', 'sessions']
export interface Config extends SkillSearchOptions {}
export const Config: z<Config> = z.object({
  maxResults: z.number().min(1).max(20).default(8),
  maxDescriptionChars: z.number().min(40).max(500).default(240),
  maxResponseBytes: z.number().min(1024).max(32768).default(8192),
})

export const DISCOVERY_NOTICE = [
  'Skill discovery is available on demand; the full skill library has not been removed.',
  'When a task names or clearly needs a skill, use solar_skill_search with a few relevant keywords or its exact name, then call the official skill tool with the exact returned name before acting.',
  'Search returns a bounded page of summaries, not instructions; follow nextOffset when another page is needed. Only load a matching skill, never infer its instructions from a summary.',
  'If solar_skill_search is unavailable, use the currently available official skill controls instead.',
].join(' ')

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'solar-skill-context': {
      kind: 'solar-skill-context'
      form: 'notice'
      summary: string
      policyVersion: 1
      retiredCatalogEntries?: number
    }
  }
}

function validatedConfig(config: Partial<Config>): Config {
  const value = { ...DEFAULT_SKILL_SEARCH_OPTIONS, ...config }
  for (const [key, min, max] of [['maxResults', 1, 20], ['maxDescriptionChars', 40, 500], ['maxResponseBytes', 1024, 32768]] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) {
      throw new Error(`SKILL_CONTEXT_CONFIG_INVALID: ${key} must be an integer from ${min} to ${max}`)
    }
  }
  return value
}

/** Validate the actual durable producer boundary before retiring its body. */
function catalogEntries(message: Message): number | undefined {
  if (message.source.kind !== 'skill-catalog') return undefined
  const source = message.source as unknown as { form?: unknown; entries?: unknown }
  if (source.form !== 'catalog' || !Array.isArray(source.entries)
    || source.entries.some(entry => entry === null || typeof entry !== 'object'
      || typeof entry.name !== 'string' || entry.name.length === 0 || typeof entry.description !== 'string')) {
    throw new Error('SKILL_CONTEXT_CATALOG_INVALID: the official catalog record has an unsupported shape; request stopped')
  }
  return source.entries.length
}

function isDiscoveryNotice(message: Message): boolean {
  return message.source.kind === 'solar-skill-context'
    && message.source.policyVersion === 1
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text === DISCOVERY_NOTICE
}

/**
 * Retire single catalog nodes, not a range spanning intervening conversation.
 * Empty developer content has an official null model projection in rc.2.
 */
export function retireHistoricalCatalogs(session: Session, position: { turn: number; step: number }, beforeWrite: () => void = () => {}): number {
  const replacements: { seq: SessionSeq; entries: number }[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const entries = catalogEntries(event.data)
    if (entries !== undefined) replacements.push({ seq, entries })
  }
  // Validate the whole plan before the first write: no partial retirement of
  // valid nodes followed by an unsupported catalog shape.
  if (replacements.length > 0) beforeWrite()
  for (const { seq, entries } of replacements) {
    session.append('developer/message', {
      ...position,
      message: createDeveloperMessage({
        content: [],
        source: {
          kind: 'solar-skill-context', form: 'notice', policyVersion: 1,
          summary: '旧技能目录已退出请求；完整技能仍可按需检索和加载。', retiredCatalogEntries: entries,
        },
      }),
    }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
  }
  return replacements.length
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const limits = validatedConfig(config)
  const pendingFlush = new WeakSet<Session>()
  const checkedSessions = new WeakSet<Session>()
  const search = defineTool({
    name: 'solar_skill_search',
    description: 'Find available skills by a few keywords or an exact name. Returns a bounded page of names and summaries; use nextOffset to continue. Load the chosen full instructions with the official skill tool before acting.',
    parameters: {
      query: { type: 'string', required: true, description: '1–256 characters: relevant keywords or the exact skill name.' },
      offset: { type: 'integer', description: 'Use nextOffset from the previous result for the same query; default 0.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const snapshot = await ctx.skills.snapshot({
        ...(exec.agent === undefined ? {} : { cwd: await ctx.workingDirectory.ensure(exec.agent, exec.signal), scope: exec.agent }),
        signal: exec.signal,
      })
      exec.signal.throwIfAborted()
      if (!snapshot.complete) throw new Error('SKILL_CONTEXT_SNAPSHOT_INCOMPLETE: skill discovery is not complete; no complete result is claimed')
      return searchSkills(snapshot.skills.filter(isModelInvocable), args.query, args.offset ?? 0, limits) as never
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '按需查找技能' }),
  })
  ctx.effect(() => ctx.tools.register(search))
  ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const canLoad = ctx.tools.get('skill', agent) !== undefined
    const canSearch = ctx.tools.get('solar_skill_search', agent) === search
    if (canLoad && !canSearch) {
      // Do not change a scoped allowlist or silently remove its only discovery
      // mechanism. Nor admit the old unbounded catalog as a hidden fallback.
      throw new Error('SKILL_CONTEXT_SEARCH_UNAVAILABLE: this agent permits skill loading but hides the bounded search tool; include solar_skill_search in its allowed tools before requesting skill discovery')
    }
    // The official listener still owns catalog production. Only its automatic
    // proposal is replaced; user messages and explicit /skill bodies remain.
    const messages = decision.messages.filter(message => catalogEntries(message) === undefined)
    retireHistoricalCatalogs(agent.session, { turn, step }, () => pendingFlush.add(agent.session))
    // A failed flush must remain a barrier on the next admission even though
    // the replaced nodes have already left the in-memory surface. Also check
    // once after reload, when this plugin's in-memory bookkeeping is new.
    if (pendingFlush.has(agent.session) || !checkedSessions.has(agent.session)) {
      let persisted: boolean
      try {
        persisted = await ctx.sessions.flush(agent.session)
      } catch (cause) {
        throw new Error('SKILL_CONTEXT_FLUSH_FAILED: canonical catalog retirement durability listener failed; request stopped', { cause })
      }
      if (!persisted) {
        throw new Error('SKILL_CONTEXT_FLUSH_FAILED: canonical catalog retirement could not be confirmed durable; request stopped')
      }
      pendingFlush.delete(agent.session)
      checkedSessions.add(agent.session)
    }
    signal.throwIfAborted()
    const visibleNotice = agent.session.deriveMessages().some(isDiscoveryNotice)
    if (canLoad && canSearch && !visibleNotice && !messages.some(isDiscoveryNotice)) messages.push(createUserMessage({
      content: [{ type: 'text', text: DISCOVERY_NOTICE }],
      source: { kind: 'solar-skill-context', form: 'notice', summary: '技能改为按需检索，完整指令仍由官方工具加载。', policyVersion: 1 },
    }))
    return { ...decision, messages }
  }, { prepend: true })
}
