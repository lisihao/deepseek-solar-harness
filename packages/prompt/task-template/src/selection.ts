/**
 * Pure, deterministic template selection: candidate filtering over the task
 * attributes, a total stable ordering, explicit-template override, and the
 * no-match/no-injection outcome, each reported through a serializable receipt.
 * Same inputs always produce the same outcome — no clock, randomness, or
 * environment reads.
 *
 * 纯函数式的确定性模板选择：按任务属性过滤候选、全序稳定排序、显式模板覆盖、
 * 无匹配即不注入，并通过可序列化回执报告。相同输入恒产生相同结果——不读
 * 时钟、随机数或环境。
 *
 * @module @deepseek-ai/dsh-task-template/selection
 */

import type {
  TaskAttributes,
  TaskTemplate,
  TaskTemplateCandidate,
  TaskTemplateInjectionLayers,
  TaskTemplateInjectionReceipt,
  TaskTemplateMatch,
  TaskTemplatePersonalization,
  TaskTemplateRenderVariables,
  TaskTemplateSelectedContent,
  TaskTemplateSelection,
  TaskTemplateSelectionRequest,
} from './types.ts'
import {
  renderTaskTemplateMethod,
  taskTemplateContentSha256,
  taskTemplateRenderVariables,
} from './render.ts'

/** Whether an optional value list admits the task's value (absent = wildcard). */
function admitsValue(allowed: readonly string[] | undefined, value: string): boolean {
  return allowed === undefined || allowed.includes(value)
}

/** Whether every required name is present in the task's list (absent = wildcard). */
function requiresAll(required: readonly string[] | undefined, available: readonly string[]): boolean {
  return required === undefined || required.every(entry => available.includes(entry))
}

/** Whether the template shares at least one operator with the task (absent = wildcard). */
function sharesOne(declared: readonly string[] | undefined, requested: readonly string[]): boolean {
  return declared === undefined || declared.some(entry => requested.includes(entry))
}

/** Whether every keyword occurs case-insensitively in the objective (absent = wildcard). */
function containsKeywords(keywords: readonly string[] | undefined, objective: string): boolean {
  if (keywords === undefined) return true
  const haystack = objective.toLowerCase()
  return keywords.every(keyword => haystack.includes(keyword.toLowerCase()))
}

/**
 * Whether one template's match criteria admit the task, applying the
 * per-dimension semantics documented on {@link TaskTemplateMatch}.
 * @param match - the template's match criteria.
 * @param attributes - the task's attributes.
 * @returns true when every constrained dimension matches.
 */
export function matchesTask(match: TaskTemplateMatch, attributes: TaskAttributes): boolean {
  return admitsValue(match.taskTypes, attributes.taskType)
    && admitsValue(match.domains, attributes.domain)
    && containsKeywords(match.objectiveKeywords, attributes.objective)
    && admitsValue(match.outputFormats, attributes.outputFormat)
    && admitsValue(match.riskLevels, attributes.riskLevel)
    && requiresAll(match.requiredTools, attributes.tools)
    && requiresAll(match.requiredSkills, attributes.skills)
    && sharesOne(match.operators, attributes.operators)
    && admitsValue(match.languages, attributes.language)
    && admitsValue(match.priorities, attributes.priority)
}

/**
 * Specificity of one match record: the count of dimensions it constrains.
 * A template constraining more dimensions of a task it matches is judged the
 * closer fit.
 * @param match - the template's match criteria.
 * @returns the number of present match dimensions.
 */
export function matchSpecificity(match: TaskTemplateMatch): number {
  return Object.values(match).filter(value => value !== undefined).length
}

/**
 * Total deterministic candidate order: specificity descending, then rank
 * descending, then name ascending by code point, then id ascending. Unique
 * ids make the order total, so equal inputs always list candidates
 * identically.
 * @param a - one candidate.
 * @param b - the other candidate.
 * @returns a negative, zero, or positive comparison value.
 */
export function compareCandidates(a: TaskTemplateCandidate, b: TaskTemplateCandidate): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity
  if (a.rank !== b.rank) return b.rank - a.rank
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Assemble the layered injection content and the layer flags for the receipt. */
function layeredContent(
  template: TaskTemplate,
  personalization: TaskTemplatePersonalization | undefined,
  attributes: TaskAttributes,
): {
  content: TaskTemplateSelectedContent
  contentSha256: string
  layers: TaskTemplateInjectionLayers
  renderVariables: TaskTemplateRenderVariables
} {
  const renderVariables = taskTemplateRenderVariables(attributes)
  const content: TaskTemplateSelectedContent = {
    method: renderTaskTemplateMethod(template.method, renderVariables),
  }
  if (personalization?.preferences !== undefined) content.preferences = personalization.preferences
  if (personalization?.memory !== undefined) content.memory = personalization.memory
  return {
    content,
    contentSha256: taskTemplateContentSha256(content),
    layers: {
      method: true,
      preferences: content.preferences !== undefined,
      memory: content.memory !== undefined,
    },
    renderVariables,
  }
}

/** Detach the attribute echo so the receipt never aliases caller-owned arrays. */
function detachAttributes(attributes: TaskAttributes): TaskAttributes {
  return {
    ...attributes,
    tools: [...attributes.tools],
    skills: [...attributes.skills],
    operators: [...attributes.operators],
  }
}

/**
 * Select the template to inject for one task. Enabled templates are filtered
 * by {@link matchesTask} and ordered by {@link compareCandidates}; the first
 * candidate wins unless the request names an explicit template, which
 * overrides the ranking (and need not itself match). No candidate and no
 * override means `skip`: nothing is injected. Naming an unknown or disabled
 * template fails loud.
 *
 * 为一个任务选择待注入模板。启用的模板经 {@link matchesTask} 过滤并按
 * {@link compareCandidates} 排序；除非请求显式指定模板（覆盖排序、且本身
 * 不要求匹配），否则首位候选胜出。无候选且无覆盖即 `skip`：不注入任何内容。
 * 指定未知或停用的模板立即报错。
 * @param templates - every stored template, in any order.
 * @param personalization - personal layers keyed by template id.
 * @param request - the task's attributes and optional explicit override.
 * @returns the deterministic selection outcome with its loggable receipt.
 */
export function selectTaskTemplate(
  templates: readonly TaskTemplate[],
  personalization: ReadonlyMap<string, TaskTemplatePersonalization>,
  request: TaskTemplateSelectionRequest,
): TaskTemplateSelection {
  const scored = templates
    .filter(template => template.enabled && matchesTask(template.match, request.attributes))
    .map(template => ({
      template,
      candidate: {
        id: template.id,
        version: template.version,
        name: template.name,
        specificity: matchSpecificity(template.match),
        rank: template.rank,
      } satisfies TaskTemplateCandidate,
    }))
    .sort((a, b) => compareCandidates(a.candidate, b.candidate))
  const candidates = scored.map(entry => entry.candidate)
  const attributes = detachAttributes(request.attributes)

  const finish = (
    outcome: Pick<TaskTemplateSelection, 'decision' | 'overrideSource' | 'rationale'> & { selected?: TaskTemplateSelection['selected'] },
    layers?: TaskTemplateInjectionLayers,
  ): TaskTemplateSelection => {
    const receipt: TaskTemplateInjectionReceipt = {
      receiptVersion: 1,
      decision: outcome.decision,
      overrideSource: outcome.overrideSource,
      ...outcome.selected === undefined
        ? {}
        : {
          templateId: outcome.selected.id,
          templateVersion: outcome.selected.version,
          contentSha256: outcome.selected.contentSha256,
          renderedContent: outcome.selected.content,
          renderVariables: outcome.selected.renderVariables,
        },
      ...layers === undefined ? {} : { layers },
      candidates,
      rationale: outcome.rationale,
      attributes,
    }
    return {
      decision: outcome.decision,
      overrideSource: outcome.overrideSource,
      ...outcome.selected === undefined ? {} : { selected: outcome.selected },
      candidates,
      rationale: outcome.rationale,
      receipt,
    }
  }

  if (request.explicitTemplateId !== undefined) {
    const template = templates.find(entry => entry.id === request.explicitTemplateId)
    if (template === undefined) {
      throw new Error(`explicit task template "${request.explicitTemplateId}" does not exist`)
    }
    if (!template.enabled) {
      throw new Error(`explicit task template "${template.id}" is disabled`)
    }
    const { content, contentSha256, layers, renderVariables } = layeredContent(
      template,
      personalization.get(template.id),
      request.attributes,
    )
    return finish({
      decision: 'inject',
      overrideSource: 'explicit',
      selected: { id: template.id, version: template.version, name: template.name, content, contentSha256, renderVariables },
      rationale: [
        `explicit template "${template.id}" version ${String(template.version)} overrides automatic selection`,
        `${String(candidates.length)} enabled template(s) matched the task attributes`,
      ],
    }, layers)
  }

  const winner = scored[0]
  if (winner === undefined) {
    return finish({
      decision: 'skip',
      overrideSource: 'none',
      rationale: ['no enabled template matches the task attributes; nothing is injected'],
    })
  }
  const { template } = winner
  const { content, contentSha256, layers, renderVariables } = layeredContent(
    template,
    personalization.get(template.id),
    request.attributes,
  )
  return finish({
    decision: 'inject',
    overrideSource: 'automatic',
    selected: { id: template.id, version: template.version, name: template.name, content, contentSha256, renderVariables },
    rationale: [
      `selected "${template.id}" version ${String(template.version)} by deterministic ranking `
      + `(specificity ${String(winner.candidate.specificity)}, rank ${String(winner.candidate.rank)}) `
      + `among ${String(candidates.length)} matching candidate(s)`,
    ],
  }, layers)
}
