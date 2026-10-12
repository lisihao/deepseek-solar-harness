/** Host parsing of explicit independent verification outcomes. */
import type { OrchestrationNodeSpecV1 } from '@deepseek-ai/dsh-orchestration'
import type { PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'

/**
 * Refuse negative, missing or unsubstantiated model-verdict acceptance.
 * @param node - the certified acceptance requirements.
 * @param result - actual sealed physical output.
 * @returns the failure reason, or undefined when this requirement is satisfied or absent.
 */
export function verificationVerdictFailure(node: OrchestrationNodeSpecV1, result: PhysicalOperatorResult): string | undefined {
  if (!node.acceptance.some(requirement => requirement.kind === 'model-verdict')) return undefined
  const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
  let value: unknown
  try { value = JSON.parse(text) } catch { return '验证者没有提交可解析的验证结果。' }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !('accepted' in value) || typeof value.accepted !== 'boolean'
    || !('reason' in value) || typeof value.reason !== 'string' || value.reason.trim().length === 0
    || !('evidence' in value) || !Array.isArray(value.evidence)
    || value.evidence.some(item => typeof item !== 'string' || item.trim().length === 0)) return '验证者提交的验证字段无效。'
  if (!value.accepted) return value.reason
  if (value.evidence.length === 0) return '验证者没有提供实际核对依据。'
  return undefined
}
