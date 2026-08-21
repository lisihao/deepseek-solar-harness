/** Native catalog validation and transparent Smart Auto profile selection. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  type ResidentExecutionProfile,
  type ResidentExecutionProfileSource,
  type ResidentModelOption,
} from '@deepseek-ai/dsh-resident-operator'

type ResidentTaskClass = 'quick' | 'standard' | 'complex' | 'extreme'

const EFFORT_ORDER: readonly PhysicalOperatorReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]

/** Fully resolved profile and provenance selected before durable command admission. */
export interface ResolvedResidentExecutionProfile {
  readonly profile: ResidentExecutionProfile
  readonly source: ResidentExecutionProfileSource
}

/**
 * Resolve manual fields against the live native catalog and fill omissions through Smart Auto.
 * @param operatorId - native product whose catalog owns the model ids.
 * @param models - current qualified product catalog.
 * @param prompt - bounded command content used only for in-memory task classification.
 * @param preference - optional caller override for model and/or effort.
 * @returns one complete profile and its selection source.
 */
export function resolveResidentExecutionProfile(
  operatorId: string,
  models: readonly ResidentModelOption[],
  prompt: readonly ContentBlock[],
  preference?: PhysicalOperatorExecutionPreference,
): ResolvedResidentExecutionProfile {
  if (models.length === 0) {
    throw new ResidentOperatorError(`${operatorId} reported no selectable models`, 'RUNTIME_UNAVAILABLE')
  }
  const taskClass = classifyTask(prompt)
  const requestedEffort = preference?.effort
  const automaticCandidates = preference?.model === undefined && requestedEffort !== undefined
    ? models.filter(model => model.supportedEfforts.includes(requestedEffort))
    : models
  if (automaticCandidates.length === 0) {
    throw new ResidentOperatorError(
      `${operatorId} does not advertise a model supporting ${String(requestedEffort)} effort`,
      'EXECUTION_PROFILE_UNSUPPORTED',
    )
  }
  const selected = preference?.model === undefined
    ? automaticModel(operatorId, automaticCandidates, taskClass)
    : models.find(option => option.model === preference.model || option.resolvedModel === preference.model)
  if (selected === undefined) {
    throw new ResidentOperatorError(
      `${operatorId} does not advertise model ${String(preference?.model)}`,
      'EXECUTION_PROFILE_UNSUPPORTED',
    )
  }
  const effort = preference?.effort === undefined
    ? automaticEffort(operatorId, selected, taskClass)
    : validateEffort(operatorId, selected, preference.effort)
  return {
    profile: {
      model: selected.model,
      ...effort === undefined ? {} : { effort },
    },
    source: preference === undefined || (preference.model === undefined && preference.effort === undefined)
      ? 'smart-auto'
      : preference.model !== undefined && preference.effort !== undefined
        ? 'manual'
        : 'mixed',
  }
}

function classifyTask(prompt: readonly ContentBlock[]): ResidentTaskClass {
  const text = prompt
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (text.length >= 6_000 || /(?:最困难|最高强度|超长任务|长期运行|全面红队|穷尽|ultra[- ]?hard|maximum effort)/iu.test(text)) {
    return 'extreme'
  }
  if (text.length >= 1_200 || /(?:深度|复杂|架构|研究|重构|系统性|全面分析|审计|根因|多阶段|long[- ]?context|architecture|research|refactor)/iu.test(text)) {
    return 'complex'
  }
  if (text.length <= 160 && /(?:简单|快速|小改|一句话|查一下|quick|tiny|small fix|one[- ]?line)/iu.test(text)) {
    return 'quick'
  }
  return 'standard'
}

function automaticModel(
  operatorId: string,
  models: readonly ResidentModelOption[],
  taskClass: ResidentTaskClass,
): ResidentModelOption {
  const pattern = operatorId === 'claude-code'
    ? taskClass === 'quick'
      ? /haiku|fastest/iu
      : taskClass === 'standard'
        ? /sonnet|efficient|routine/iu
        : taskClass === 'extreme'
          ? /fable|most capable|hardest|longest-running/iu
          : /opus|recommended|complex/iu
    : taskClass === 'quick'
      ? /luna|spark|affordable|small|ultra-fast/iu
      : taskClass === 'standard'
        ? /terra|balanced|everyday/iu
        : /sol|frontier/iu
  return models.find(model => pattern.test(`${model.model} ${model.displayName} ${model.description}`))
    ?? models.find(model => model.isDefault)
    ?? models[0] as ResidentModelOption
}

function automaticEffort(
  operatorId: string,
  model: ResidentModelOption,
  taskClass: ResidentTaskClass,
): PhysicalOperatorReasoningEffort | undefined {
  if (model.supportedEfforts.length === 0) return undefined
  const desired: PhysicalOperatorReasoningEffort = taskClass === 'quick'
    ? 'low'
    : taskClass === 'standard'
      ? model.defaultEffort ?? 'medium'
      : taskClass === 'complex'
        ? 'xhigh'
        : operatorId === 'codex'
          ? 'ultra'
          : 'max'
  if (model.supportedEfforts.includes(desired)) return desired
  const desiredIndex = EFFORT_ORDER.indexOf(desired)
  return [...model.supportedEfforts]
    .sort((left, right) => Math.abs(EFFORT_ORDER.indexOf(left) - desiredIndex)
      - Math.abs(EFFORT_ORDER.indexOf(right) - desiredIndex))[0]
}

function validateEffort(
  operatorId: string,
  model: ResidentModelOption,
  effort: PhysicalOperatorReasoningEffort,
): PhysicalOperatorReasoningEffort {
  if (!model.supportedEfforts.includes(effort)) {
    throw new ResidentOperatorError(
      `${operatorId} model ${model.model} does not advertise ${effort} effort`,
      'EXECUTION_PROFILE_UNSUPPORTED',
    )
  }
  return effort
}
