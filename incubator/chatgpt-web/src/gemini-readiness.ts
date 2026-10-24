import type { GeminiSemanticSelectors } from './gemini-port.js'

/**
 * A browser-visible Gemini control is accepted only after an operator records
 * its exact semantic selector.  This module deliberately describes whether
 * that configuration is complete; it does not claim that a live webpage was
 * observed or that any model request may succeed.
 */
export type GeminiReadinessPhase = 'plan' | 'research' | 'thinking'

export type GeminiSemanticRequirement =
  | 'submitSelector'
  | 'promptReceiptSelector'
  | 'planReadyMarker'
  | 'researchStartSelector'
  | 'researchReportReadyMarker'
  | 'thinking'

export interface GeminiReadinessPhaseInput {
  readonly phase: GeminiReadinessPhase
  /** The thinking control is only required when this stage requests effort. */
  readonly effortLabel?: string
}

export interface GeminiReadinessTarget {
  readonly id: string
  readonly label: string
  /** A Gemini research node owns both its plan and confirmed-research phases. */
  readonly phases: readonly GeminiReadinessPhaseInput[]
}

export interface GeminiReadinessTargetResult {
  readonly id: string
  readonly label: string
  readonly missing: readonly GeminiSemanticRequirement[]
  /** True means the runtime may perform its normal page preflight, not accepted live compatibility. */
  readonly configurationComplete: boolean
}

export interface GeminiSemanticRequirementStatus {
  readonly id: GeminiSemanticRequirement
  readonly label: string
  readonly configured: boolean
  /** Whether this requirement is absent, in saved preferences, or an observed built-in adapter path. */
  readonly source: 'missing' | 'preferences' | 'observed-adapter'
  readonly requiredBy: readonly string[]
}

export interface GeminiReadinessReport {
  /**
   * All supplied targets have their required semantic configuration. The
   * concrete port still verifies exact visible/unique controls before a click.
   */
  readonly configurationComplete: boolean
  readonly targets: readonly GeminiReadinessTargetResult[]
  readonly requirements: readonly GeminiSemanticRequirementStatus[]
}

const REQUIREMENT_ORDER: readonly GeminiSemanticRequirement[] = [
  'submitSelector',
  'promptReceiptSelector',
  'planReadyMarker',
  'researchStartSelector',
  'researchReportReadyMarker',
  'thinking',
]

const REQUIREMENT_LABELS: Readonly<Record<GeminiSemanticRequirement, string>> = {
  submitSelector: '发送按钮',
  promptReceiptSelector: '原问题回执',
  planReadyMarker: '研究计划完成标志',
  researchStartSelector: '研究启动按钮',
  researchReportReadyMarker: '研究报告完成标志',
  thinking: '思考等级选择与回读',
}

/**
 * Read-only selectors observed on an existing Gemini page on 2026-10-24.
 * They include the one user-authorized no-send draft observation, but do not
 * prove a Send effect, a prompt receipt, or enabled plan-start availability.
 * Callers clone this value before handing it to mutable execution code.
 */
const OBSERVED_GEMINI_SEMANTICS: GeminiSemanticSelectors = {
  submitSelector: 'button[aria-label="发送"]',
  promptReceiptSelector: 'user-query-content .query-text',
  planReadyMarker: 'deep-research-confirmation-widget',
  researchStartSelector: 'button[aria-label="开始研究"]',
  researchReportReadyMarker: 'deep-research-immersive-panel',
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasThinkingSelectors(value: GeminiSemanticSelectors | undefined): boolean {
  const thinking = value?.thinking
  return nonEmptyString(thinking?.triggerSelector)
    && nonEmptyString(thinking?.optionSelector)
    && nonEmptyString(thinking?.selectedSelector)
}

export function geminiSemanticRequirementLabel(requirement: GeminiSemanticRequirement): string {
  return REQUIREMENT_LABELS[requirement]
}

export function observedGeminiSemantics(value: GeminiSemanticSelectors | undefined): GeminiSemanticSelectors {
  return {
    ...OBSERVED_GEMINI_SEMANTICS,
    ...(value === undefined ? {} : value),
    ...(value?.visibleQuota === undefined ? {} : { visibleQuota: { ...value.visibleQuota } }),
    ...(value?.thinking === undefined ? {} : { thinking: { ...value.thinking } }),
  }
}

/** List requirements without applying configuration or built-in observations. */
export function requiredGeminiSemantics(
  phase: GeminiReadinessPhase,
  effortLabel: string | undefined,
): readonly GeminiSemanticRequirement[] {
  const required = phase === 'plan'
    ? ['submitSelector', 'promptReceiptSelector', 'planReadyMarker'] as const
    : phase === 'research'
      ? ['promptReceiptSelector', 'researchStartSelector', 'researchReportReadyMarker'] as const
      : ['submitSelector', 'promptReceiptSelector'] as const
  return phase === 'thinking' && effortLabel !== undefined
    ? [...required, 'thinking']
    : required
}

function configuredByPreference(requirement: GeminiSemanticRequirement, semantics: GeminiSemanticSelectors | undefined): boolean {
  return requirement === 'thinking'
    ? hasThinkingSelectors(semantics)
    : nonEmptyString(semantics?.[requirement])
}

function requirementSource(
  requirement: GeminiSemanticRequirement,
  effortLabel: string | undefined,
  semantics: GeminiSemanticSelectors | undefined,
): GeminiSemanticRequirementStatus['source'] {
  // The fixed high → 高 mapping is implemented by the observed adapter rather
  // than configurable CSS. Other effort labels still require explicit fields.
  if (requirement === 'thinking' && effortLabel === 'high') return 'observed-adapter'
  if (configuredByPreference(requirement, semantics)) return 'preferences'
  const effective = observedGeminiSemantics(semantics)
  if (requirement === 'thinking') return hasThinkingSelectors(effective) ? 'preferences' : 'missing'
  return nonEmptyString(effective[requirement]) ? 'observed-adapter' : 'missing'
}

/**
 * Return the exact semantic fields a port requires before it may allocate a
 * TaskSpace or click.  Keeping this pure lets the entry path, settings UI,
 * and port share one contract without importing Node-only browser code.
 */
export function missingGeminiSemantics(
  phase: GeminiReadinessPhase,
  effortLabel: string | undefined,
  semantics: GeminiSemanticSelectors | undefined,
): readonly GeminiSemanticRequirement[] {
  return requiredGeminiSemantics(phase, effortLabel)
    .filter(requirement => requirementSource(requirement, effortLabel, semantics) === 'missing')
}

/**
 * Evaluate persisted configuration plus the finite, documented no-model
 * adapter paths. Nothing here is a live-provider acceptance: the port still
 * verifies exact visible/unique controls before any click or completion.
 */
export function assessGeminiReadiness(
  semantics: GeminiSemanticSelectors | undefined,
  targets: readonly GeminiReadinessTarget[],
): GeminiReadinessReport {
  const targetsWithMissing = targets.map((target): GeminiReadinessTargetResult => {
    const missing = Array.from(new Set(target.phases.flatMap(phase => missingGeminiSemantics(
      phase.phase,
      phase.effortLabel,
      semantics,
    ))))
    return {
      id: target.id,
      label: target.label,
      missing,
      configurationComplete: missing.length === 0,
    }
  })
  const requiredBy = new Map<GeminiSemanticRequirement, string[]>()
  const sources = new Map<GeminiSemanticRequirement, Set<GeminiSemanticRequirementStatus['source']>>()
  for (const target of targets) {
    for (const phase of target.phases) {
      for (const requirement of requiredGeminiSemantics(phase.phase, phase.effortLabel)) {
        const values = requiredBy.get(requirement) ?? []
        values.push(target.label)
        requiredBy.set(requirement, values)
        const valuesBySource = sources.get(requirement) ?? new Set<GeminiSemanticRequirementStatus['source']>()
        valuesBySource.add(requirementSource(requirement, phase.effortLabel, semantics))
        sources.set(requirement, valuesBySource)
      }
    }
  }
  const requirements = REQUIREMENT_ORDER
    .filter(requirement => requiredBy.has(requirement))
    .map((requirement): GeminiSemanticRequirementStatus => {
      const sourceSet = sources.get(requirement) ?? new Set<GeminiSemanticRequirementStatus['source']>()
      const source = sourceSet.has('missing')
        ? 'missing'
        : sourceSet.has('preferences')
          ? 'preferences'
          : 'observed-adapter'
      return {
        id: requirement,
        label: geminiSemanticRequirementLabel(requirement),
        configured: source !== 'missing',
        source,
        requiredBy: Array.from(new Set(requiredBy.get(requirement) ?? [])),
      }
    })
  return {
    configurationComplete: targetsWithMissing.every(target => target.configurationComplete),
    targets: targetsWithMissing,
    requirements,
  }
}
