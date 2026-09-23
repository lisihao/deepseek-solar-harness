/**
 * Agent-request Consumer for task prompt templates. It classifies only the
 * current logical user task — the open turn's originating request, not each
 * model-visible step — asks `ctx.taskTemplates` for one deterministic match,
 * and injects the selected content as a durable user-role instruction
 * message at most once for that task.
 *
 * Every decision (inject or skip) is also recorded as a log-only, replay-safe
 * session event, so a skip is attributable even though it appends no
 * surface message. When the injected surface message is later shadowed by
 * compaction while the same turn is still open, the exact pinned receipt from
 * that log event — never a fresh selection — is restored once; a later turn
 * (a new logical task) always re-selects from scratch and never reactivates
 * an earlier task's template.
 *
 * @module @deepseek-ai/dsh-task-template-context
 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readModelSelection, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  TaskAttributes,
  TaskRiskLevel,
  TaskTemplateInjectionReceipt,
  TaskTemplateSelection,
} from '@deepseek-ai/dsh-task-template'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'task-template-context'
export const inject = ['taskTemplates', 'tools']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Durable user-managed task guidance selected for one concrete request. */
    'task-template': {
      kind: 'task-template'
      form: 'instructions'
      receipt: TaskTemplateInjectionReceipt
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One decision for the open turn's logical user task — log-only, no
     * surfaceOp, always appended with `ignorable: true` since it is this
     * plugin's own attributable record and its loss cannot affect core
     * session reconstruction. `restored: true` marks a compaction-recovery
     * re-append of the exact pinned receipt from an earlier `inject` in the
     * same turn, rather than a fresh selection, so a reader can tell the two
     * apart without re-deriving the decision.
     */
    'task-template/decided': {
      turn: number
      receipt: TaskTemplateInjectionReceipt
      restored?: true
    }
  }
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u

/** Inputs known at the agent pre-step boundary. */
export interface TaskAttributeInferenceInput {
  readonly objective: string
  readonly operator?: string
  readonly tools?: readonly string[]
  readonly skills?: readonly string[]
}

function includes(value: string, pattern: RegExp): boolean {
  return pattern.test(value)
}

/**
 * Determine the task category used by template matching.
 * @param objective - current logical task text.
 * @returns the deterministic category.
 */
export function inferTaskType(objective: string): string {
  if (includes(objective, /(?:洞察|insight|趋势报告|行业报告)/iu)) return 'insight-report'
  if (includes(objective, /(?:研究|调研|文献|论文|research|survey)/iu)) return 'research'
  if (includes(objective, /(?:架构|architecture|system design|技术设计)/iu)) return 'architecture'
  if (includes(objective, /(?:审查|评审|review|audit)/iu)) return 'review'
  if (includes(objective, /(?:规划|计划|plan|roadmap)/iu)) return 'planning'
  if (includes(objective, /(?:修复|实现|开发|重构|调试|bug|代码|code|implement|refactor)/iu)) return 'coding'
  if (includes(objective, /(?:文档|报告|文章|readme|document|report|write)/iu)) return 'writing'
  return 'general'
}

/**
 * Determine the subject domain used by template matching.
 * @param objective - current logical task text.
 * @returns the deterministic domain.
 */
export function inferTaskDomain(objective: string): string {
  if (includes(objective, /(?:前端|界面|ui\b|ux\b|react|css|frontend)/iu)) return 'frontend'
  if (includes(objective, /(?:后端|服务端|数据库|api\b|backend|server|sqlite|postgres)/iu)) return 'backend'
  if (includes(objective, /(?:部署|运维|ci\b|cd\b|容器|网络|集群|infrastructure|devops)/iu)) return 'infrastructure'
  if (includes(objective, /(?:投资|现金|收益|金融|股票|基金|finance|portfolio)/iu)) return 'finance'
  if (includes(objective, /(?:法律|法规|合规|政策|legal|regulation|compliance)/iu)) return 'legal'
  if (includes(objective, /(?:\bai\b|agent|智能体|模型|llm|提示词|prompt)/iu)) return 'agent-systems'
  return 'general'
}

/**
 * Determine the requested output category used by template matching.
 * @param objective - current logical task text.
 * @returns the deterministic output category.
 */
export function inferOutputFormat(objective: string): string {
  if (includes(objective, /(?:架构图|流程图|diagram|svg\b)/iu)) return 'diagram'
  if (includes(objective, /(?:html|网页报告)/iu)) return 'html-report'
  if (includes(objective, /(?:json|结构化数据|structured)/iu)) return 'structured-data'
  if (includes(objective, /(?:文档|报告|readme|document|report)/iu)) return 'document'
  if (includes(objective, /(?:修复|实现|开发|重构|代码|code|implement|refactor)/iu)) return 'code-change'
  return 'answer'
}

/**
 * Classify execution risk without granting authority.
 * @param objective - current logical task text.
 * @returns the conservative risk level.
 */
export function inferRiskLevel(objective: string): TaskRiskLevel {
  if (includes(objective, /(?:删除生产|清空数据库|发布生产|转账|下单交易|rotate secret|production deploy)/iu)) return 'critical'
  if (includes(objective, /(?:删除|部署|发布|迁移|安全|密钥|投资|法律|delete|deploy|release|migration|security)/iu)) return 'high'
  if (includes(objective, /(?:修改|写入|安装|配置|edit|write|install|configure)/iu)) return 'medium'
  return 'low'
}

/**
 * Extract explicit skill names without loading or claiming them.
 * @param objective - current logical task text.
 * @returns unique lowercase skill names in stable order.
 */
export function inferSkillNames(objective: string): string[] {
  const names = new Set<string>()
  for (const match of objective.matchAll(/(?:\$|skill\s*[:：]\s*)([a-z0-9][a-z0-9_-]*)/giu)) {
    const captured = match[1]
    /* v8 ignore next -- the regular expression's required capture always populates match[1] */
    if (captured === undefined) continue
    names.add(captured.toLowerCase())
  }
  if (includes(objective, /(?:research skill|研究技能)/iu)) names.add('research')
  return [...names].sort()
}

/**
 * Infer the complete typed attributes consumed by the selector.
 * @param input - objective plus the operator, tools, and skills known at admission.
 * @returns deterministic task attributes.
 */
export function inferTaskAttributes(input: TaskAttributeInferenceInput): TaskAttributes {
  const objective = input.objective.trim()
  return {
    taskType: inferTaskType(objective),
    domain: inferTaskDomain(objective),
    objective,
    outputFormat: inferOutputFormat(objective),
    riskLevel: inferRiskLevel(objective),
    tools: [...new Set(input.tools ?? [])].sort(),
    skills: [...new Set(input.skills ?? inferSkillNames(objective))].sort(),
    operators: input.operator === undefined ? [] : [input.operator],
    language: CJK.test(objective) ? 'zh-CN' : 'en',
    priority: includes(objective, /(?:紧急|立即|马上|urgent|asap)/iu) ? 'urgent' : 'normal',
  }
}

const INJECTION_PRECEDENCE = 'The current user request and system safety rules take priority over this user-managed template.'

/** Build the unambiguous JSON instruction payload shared by a fresh injection and a restored one. */
function injectionPayload(
  id: string,
  version: number,
  name: string,
  contentSha256: string,
  content: TaskTemplateSelection['selected'] extends undefined ? never : NonNullable<TaskTemplateSelection['selected']>['content'],
): string {
  return JSON.stringify({
    dshTaskPromptTemplate: {
      version: 1,
      precedence: INJECTION_PRECEDENCE,
      template: { id, version, name, contentSha256 },
      content,
    },
  })
}

/**
 * Render one selected template as unambiguous JSON instruction data.
 * @param selection - an injecting selection with pinned content.
 * @returns the model-visible JSON document.
 * @throws when the selection is a skip.
 */
export function renderTaskTemplateInjection(selection: TaskTemplateSelection): string {
  if (selection.decision !== 'inject' || selection.selected === undefined) {
    throw new Error('task-template-context: cannot render a skipped selection')
  }
  const { id, version, name, contentSha256, content } = selection.selected
  return injectionPayload(id, version, name, contentSha256, content)
}

/**
 * Render an earlier `inject` receipt as the same unambiguous JSON instruction
 * data, for restoring the exact pinned content after compaction shadows the
 * original message. Current receipts pin the display name directly. Receipts
 * written before that field existed recover an automatic selection's name
 * from its candidate entry and otherwise fall back to the template id.
 * @param receipt - the earlier injecting receipt to reconstruct.
 * @returns the model-visible JSON document.
 * @throws when the receipt records a skip or lacks required pinned fields.
 */
export function renderTaskTemplateReceipt(receipt: TaskTemplateInjectionReceipt): string {
  if (receipt.decision !== 'inject'
    || receipt.templateId === undefined
    || receipt.templateVersion === undefined
    || receipt.contentSha256 === undefined
    || receipt.renderedContent === undefined) {
    throw new Error('task-template-context: cannot restore a skipped receipt')
  }
  const name = receipt.templateName
    ?? receipt.candidates.find(entry => entry.id === receipt.templateId)?.name
    ?? receipt.templateId
  return injectionPayload(receipt.templateId, receipt.templateVersion, name, receipt.contentSha256, receipt.renderedContent)
}

function currentUserTask(messages: readonly UserMessage[]): UserMessage | undefined {
  return messages.findLast(message => message.source.kind === 'user')
}

function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function selectedOperator(agent: Agent): string | undefined {
  const selection = readModelSelection(agent).selection
  if (selection === undefined) return undefined
  if (selection.provider === 'dsh-physical-operator') return selection.model
  return selection.provider
}

/**
 * The durable seq range of the current logical user task: from the last
 * `turn/start` (exclusive) to the end of the log. A session with no
 * `turn/start` yet (a direct fixture driving `agent/pre-step` without the
 * concrete `AgentLoop`) treats its whole log as the current task's range —
 * every event belongs to one implicit turn.
 */
function currentTurnStart(session: Session): { turn: number; afterSeq: number } {
  const start = session.events.findLast(event => event.type === 'turn/start')
  return start === undefined ? { turn: 0, afterSeq: -1 } : { turn: start.data.turn, afterSeq: start.seq }
}

/** Durable events strictly after `afterSeq`, the current task's own history. */
function taskEvents(session: Session, afterSeq: number): readonly SessionEvent[] {
  return afterSeq < 0 ? session.events : session.events.filter(event => event.seq > afterSeq)
}

/** Whether a durable `user/message` event at `seq` is still on the live surface (not shadowed by compaction). */
function isLive(session: Session, seq: number): boolean {
  return session.surface.nodes.includes(seq)
}

/** The latest `task-template/decided` log event for the current task, if any. */
function latestDecision(events: readonly SessionEvent[]): SessionEvent<'task-template/decided'> | undefined {
  return events.findLast((event): event is SessionEvent<'task-template/decided'> => event.type === 'task-template/decided')
}

/** Whether the turn retains a live message carrying its own pinned inject receipt. */
function hasLiveInjection(
  session: Session,
  events: readonly SessionEvent[],
  receipt: TaskTemplateInjectionReceipt,
): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'task-template'
    && isDeepStrictEqual(event.data.source.receipt, receipt)
    && isLive(session, event.seq))
}

/**
 * Select and inject at most one template for each open turn's logical user
 * task, reusing an already-injected message across that turn's later steps,
 * restoring the exact pinned receipt once if compaction shadows it while the
 * same turn is still open, and recording every decision — including a skip —
 * as an attributable, replay-safe log event.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const { turn, afterSeq } = currentTurnStart(agent.session)
    const durable = taskEvents(agent.session, afterSeq)
    const current = currentUserTask([
      ...durable.flatMap(event => event.type === 'user/message' ? [event.data] : []),
      ...decision.messages,
    ])
    if (current === undefined) return decision

    const priorDecision = latestDecision(durable)
    const pendingOwnInjection = priorDecision?.data.receipt.decision === 'inject'
      && decision.messages.some(message => message.source.kind === 'task-template'
        && isDeepStrictEqual(message.source.receipt, priorDecision.data.receipt))
    const retainedOwnInjection = priorDecision?.data.receipt.decision === 'inject'
      && hasLiveInjection(agent.session, durable, priorDecision.data.receipt)
    // One logical user task may span many Agent steps within its turn. Reuse
    // only a live or pending message attributable to this turn's decision;
    // unrelated context inherited from a parent task cannot suppress a
    // child task's own selection.
    if (retainedOwnInjection || pendingOwnInjection) {
      return decision
    }

    if (priorDecision !== undefined) {
      // This turn already decided once. Its injected message is absent or was
      // shadowed by compaction — never re-select; restore the exact pinned
      // receipt so a later step sees the same instruction, and stop once
      // restored so a second compaction cannot restore again.
      if (priorDecision.data.restored === true || priorDecision.data.receipt.decision !== 'inject') {
        return decision
      }
      agent.session.append('task-template/decided', { turn, receipt: priorDecision.data.receipt, restored: true }, { ignorable: true })
      const restored = createUserMessage({
        content: [{ type: 'text', text: renderTaskTemplateReceipt(priorDecision.data.receipt) }],
        source: { kind: 'task-template', form: 'instructions', receipt: priorDecision.data.receipt },
      })
      return { kind: 'enter', messages: [...decision.messages, restored] }
    }

    const objective = textOf(current)
    if (objective.length === 0) return decision
    const operator = selectedOperator(agent)
    const attributes = inferTaskAttributes({
      objective,
      ...operator === undefined ? {} : { operator },
      tools: ctx.tools.schemas(agent).map(tool => tool.name),
    })
    const selection = ctx.taskTemplates.select({ attributes })
    agent.session.append('task-template/decided', { turn, receipt: selection.receipt }, { ignorable: true })
    if (selection.decision === 'skip') return decision
    const injected = createUserMessage({
      content: [{ type: 'text', text: renderTaskTemplateInjection(selection) }],
      source: { kind: 'task-template', form: 'instructions', receipt: selection.receipt },
    })
    return { kind: 'enter', messages: [...decision.messages, injected] }
  })
}
