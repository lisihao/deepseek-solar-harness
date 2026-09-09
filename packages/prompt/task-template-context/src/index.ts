/**
 * Agent-request Consumer for task prompt templates. It classifies only the
 * current user task, asks `ctx.taskTemplates` for one deterministic match, and
 * injects the selected content as a durable user-role instruction message.
 *
 * @module @deepseek-ai/dsh-task-template-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
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

/** Deterministic task category used by template matching. */
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

/** Deterministic subject domain used by template matching. */
export function inferTaskDomain(objective: string): string {
  if (includes(objective, /(?:前端|界面|ui\b|ux\b|react|css|frontend)/iu)) return 'frontend'
  if (includes(objective, /(?:后端|服务端|数据库|api\b|backend|server|sqlite|postgres)/iu)) return 'backend'
  if (includes(objective, /(?:部署|运维|ci\b|cd\b|容器|网络|集群|infrastructure|devops)/iu)) return 'infrastructure'
  if (includes(objective, /(?:投资|现金|收益|金融|股票|基金|finance|portfolio)/iu)) return 'finance'
  if (includes(objective, /(?:法律|法规|合规|政策|legal|regulation|compliance)/iu)) return 'legal'
  if (includes(objective, /(?:\bai\b|agent|智能体|模型|llm|提示词|prompt)/iu)) return 'agent-systems'
  return 'general'
}

/** Deterministic requested output category used by template matching. */
export function inferOutputFormat(objective: string): string {
  if (includes(objective, /(?:架构图|流程图|diagram|svg\b)/iu)) return 'diagram'
  if (includes(objective, /(?:html|网页报告)/iu)) return 'html-report'
  if (includes(objective, /(?:json|结构化数据|structured)/iu)) return 'structured-data'
  if (includes(objective, /(?:文档|报告|readme|document|report)/iu)) return 'document'
  if (includes(objective, /(?:修复|实现|开发|重构|代码|code|implement|refactor)/iu)) return 'code-change'
  return 'answer'
}

/** Conservative execution-risk classification; it grants no authority. */
export function inferRiskLevel(objective: string): TaskRiskLevel {
  if (includes(objective, /(?:删除生产|清空数据库|发布生产|转账|下单交易|rotate secret|production deploy)/iu)) return 'critical'
  if (includes(objective, /(?:删除|部署|发布|迁移|安全|密钥|投资|法律|delete|deploy|release|migration|security)/iu)) return 'high'
  if (includes(objective, /(?:修改|写入|安装|配置|edit|write|install|configure)/iu)) return 'medium'
  return 'low'
}

/** Extract explicit skill names without loading or claiming them. */
export function inferSkillNames(objective: string): string[] {
  const names = new Set<string>()
  for (const match of objective.matchAll(/(?:\$|skill\s*[:：]\s*)([a-z0-9][a-z0-9_-]*)/giu)) {
    if (match[1] !== undefined) names.add(match[1].toLowerCase())
  }
  if (includes(objective, /(?:research skill|研究技能)/iu)) names.add('research')
  return [...names].sort()
}

/** Infer the complete typed attributes consumed by the selector. */
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

/** Render one selected template as unambiguous JSON instruction data. */
export function renderTaskTemplateInjection(selection: TaskTemplateSelection): string {
  if (selection.decision !== 'inject' || selection.selected === undefined) {
    throw new Error('task-template-context: cannot render a skipped selection')
  }
  return JSON.stringify({
    dshTaskPromptTemplate: {
      version: 1,
      precedence: 'The current user request and system safety rules take priority over this user-managed template.',
      template: {
        id: selection.selected.id,
        version: selection.selected.version,
        name: selection.selected.name,
        contentSha256: selection.selected.contentSha256,
      },
      content: selection.selected.content,
    },
  })
}

function currentUserTask(messages: readonly UserMessage[]): { readonly message: UserMessage; readonly index: number } | undefined {
  const index = messages.findLastIndex(message => message.source.kind === 'user')
  const message = messages[index]
  return message === undefined ? undefined : { message, index }
}

function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function selectedOperator(agent: Agent): string | undefined {
  if (agent.options.provider === 'dsh-physical-operator') return agent.options.model
  return agent.options.provider
}

/** Select and inject at most one template for each admitted current user task. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const current = currentUserTask(decision.messages)
    if (current === undefined) return decision
    // One logical user request may take many Agent steps. Its already-logged
    // template instruction is reused rather than appended again each step.
    if (decision.messages.slice(current.index + 1).some(message => message.source.kind === 'task-template')) {
      return decision
    }
    const objective = textOf(current.message)
    if (objective.length === 0) return decision
    const operator = selectedOperator(agent)
    const attributes = inferTaskAttributes({
      objective,
      ...operator === undefined ? {} : { operator },
      tools: ctx.tools.schemas(agent).map(tool => tool.name),
    })
    const selection = ctx.taskTemplates.select({ attributes })
    if (selection.decision === 'skip') return decision
    const injected = createUserMessage({
      content: [{ type: 'text', text: renderTaskTemplateInjection(selection) }],
      source: { kind: 'task-template', form: 'instructions', receipt: selection.receipt },
    })
    return { kind: 'enter', messages: [...decision.messages, injected] }
  })
}
