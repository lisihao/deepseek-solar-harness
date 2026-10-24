import type { StudioGraph, StudioIssue } from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import type { InsightConfigV1 } from './insight-contract.js'
import {
  assessGeminiReadiness,
  geminiSemanticRequirementLabel,
  type GeminiReadinessReport,
  type GeminiReadinessTarget,
  type GeminiReadinessTargetResult,
} from './gemini-readiness.js'
import type { GeminiSemanticSelectors } from './gemini-port.js'

type RequestedSelection = { readonly effortLabel?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestedSelection(value: unknown): RequestedSelection {
  if (!isRecord(value) || typeof value.effortLabel !== 'string') return {}
  return { effortLabel: value.effortLabel }
}

function semantics(value: unknown): GeminiSemanticSelectors | undefined {
  return isRecord(value) ? value as GeminiSemanticSelectors : undefined
}

/** The canonical three Gemini stages from the editable Insight preferences. */
export function insightGeminiReadiness(
  config: Pick<InsightConfigV1, 'plan' | 'research' | 'polish'>,
  geminiSemantics: GeminiSemanticSelectors | undefined,
): GeminiReadinessReport {
  return assessGeminiReadiness(geminiSemantics, [
    {
      id: 'gemini-research',
      label: 'Gemini 深度研究',
      phases: [
        { phase: 'plan', effortLabel: config.plan.requested.effortLabel },
        { phase: 'research', effortLabel: config.research.requested.effortLabel },
      ],
    },
    {
      id: 'gemini-thinking',
      label: 'Gemini 文字润色',
      phases: [{ phase: 'thinking', effortLabel: config.polish.requested.effortLabel }],
    },
  ])
}

function graphGeminiTargets(graph: StudioGraph): readonly GeminiReadinessTarget[] {
  const targets: GeminiReadinessTarget[] = []
  for (const node of graph.nodes) {
    if (node.kind === 'gemini-research') {
      targets.push({
        id: node.id,
        label: node.label,
        phases: [
          { phase: 'plan', effortLabel: requestedSelection(node.parameters.planRequested).effortLabel },
          { phase: 'research', effortLabel: requestedSelection(node.parameters.requested).effortLabel },
        ],
      })
    } else if (node.kind === 'gemini-thinking') {
      targets.push({
        id: node.id,
        label: node.label,
        phases: [{ phase: 'thinking', effortLabel: requestedSelection(node.parameters.requested).effortLabel }],
      })
    }
  }
  return targets
}

export function geminiReadinessIssueMessage(target: GeminiReadinessTargetResult): string {
  return `完整洞察流程尚不能启动：${target.label} 的网页适配缺少已核实的${target.missing.map(geminiSemanticRequirementLabel).join('、')}。本次不会启动前序模型调用；需要由插件维护者完成适配验收。`
}

/**
 * Known missing configuration stops the full graph before any paid
 * predecessor. Configuration complete only permits normal page preflight; the
 * port still requires each configured control/marker to be visible and unique
 * before it clicks or records a completion.
 */
export function flowReadiness(graph: StudioGraph): readonly StudioIssue[] {
  const report = assessGeminiReadiness(semantics(graph.parameters.geminiSemantics), graphGeminiTargets(graph))
  return report.targets
    .filter(target => !target.configurationComplete)
    .map((target): StudioIssue => ({
      nodeId: target.id,
      message: geminiReadinessIssueMessage(target),
    }))
}
