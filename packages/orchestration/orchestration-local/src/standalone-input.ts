/** JSON validation and exact bottom-operator exclusion for the first standalone text subset. */
import { OrchestrationError, type StandaloneRlmStartRequest } from '@deepseek-ai/dsh-orchestration'
import { parseOperatorContextEnvelope, renderOperatorContextEnvelopeText } from '@deepseek-ai/dsh-system-prompt'
import { canonicalJson } from './canonical.ts'
import { validateGraph } from './graph.ts'

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrchestrationError(name + ' must be an object', 'GRAPH_INVALID')
  }
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new OrchestrationError(name + ' contains unsupported fields', 'GRAPH_INVALID')
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new OrchestrationError(name + ' must be non-empty text', 'GRAPH_INVALID')
  return value
}

/**
 * Validate the explicit exclusion set at the configuration boundary.
 * @param values - configured wrapper identities, never inferred from current catalogs.
 * @returns unique, stable identities for the daemon manifest.
 */
export function standaloneRlmOperatorIds(values: readonly string[]): readonly string[] {
  if (values.some(id => typeof id !== 'string' || id.trim() !== id || id.length === 0)
    || new Set(values).size !== values.length) {
    throw new OrchestrationError('standalone RLM operator identities must be distinct non-empty exact strings', 'GRAPH_INVALID')
  }
  return Object.freeze([...values].sort())
}

/**
 * Reject every wrapper as a physical leaf, including inherited and recovered selections.
 * @param operatorId - actual selected physical identity.
 * @param excluded - explicitly configured outer wrapper identities.
 */
export function assertStandaloneRlmBottomOperator(operatorId: string, excluded: readonly string[]): void {
  if (excluded.includes(operatorId)) {
    throw new OrchestrationError('standalone RLM wrapper cannot execute as a bottom-level operator: ' + operatorId, 'GRAPH_INVALID')
  }
}

/**
 * Validate owner-local JSON before command acceptance; this does not authenticate a Host across IPC.
 * @param value - complete wire request.
 * @param outerIds - exact configured outer wrapper identities.
 * @returns detached input whose original text/envelope and single-node graph agree.
 */
export function parseStandaloneRlmStart(value: unknown, outerIds: readonly string[]): StandaloneRlmStartRequest {
  const request = record(value, 'standalone request')
  fields(request, ['input', 'compile'], 'standalone request')
  const input = record(request.input, 'standalone input')
  fields(input, ['version', 'operatorId', 'executionId', 'label', 'prompt', 'contextEnvelope', 'driver'], 'standalone input')
  if (input.version !== 1 || !outerIds.includes(text(input.operatorId, 'operatorId'))) {
    throw new OrchestrationError('standalone input requires version 1 and an explicitly configured outer identity', 'GRAPH_INVALID')
  }
  text(input.executionId, 'executionId')
  if (input.label !== undefined) text(input.label, 'label')
  if (!Array.isArray(input.prompt) || input.prompt.length === 0) {
    throw new OrchestrationError('standalone prompt must contain text blocks', 'GRAPH_INVALID')
  }
  for (const block of input.prompt) {
    const item = record(block, 'prompt block')
    fields(item, ['type', 'text'], 'prompt block')
    if (item.type !== 'text' || typeof item.text !== 'string') {
      throw new OrchestrationError('standalone first slice supports text blocks only', 'GRAPH_INVALID')
    }
  }
  if (input.contextEnvelope !== undefined) {
    const envelope = parseOperatorContextEnvelope(input.contextEnvelope)
    if (canonicalJson(envelope.task) !== canonicalJson(input.prompt)) {
      throw new OrchestrationError('standalone envelope task must exactly match prompt blocks', 'GRAPH_INVALID')
    }
  }
  const driver = record(input.driver, 'standalone driver')
  fields(driver, driver.kind === 'resident' ? ['kind', 'operatorId', 'model', 'effort'] : ['kind', 'operatorId', 'model'], 'standalone driver')
  if (driver.kind !== 'resident' && driver.kind !== 'model-worker') {
    throw new OrchestrationError('unsupported standalone driver kind', 'GRAPH_INVALID')
  }
  assertStandaloneRlmBottomOperator(text(driver.operatorId, 'driver.operatorId'), outerIds)
  text(driver.model, 'driver.model')
  if (driver.effort !== undefined && (typeof driver.effort !== 'string'
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(driver.effort))) {
    throw new OrchestrationError('unsupported standalone Resident effort', 'GRAPH_INVALID')
  }
  const compile = record(request.compile, 'standalone compile')
  fields(compile, ['intent', 'graph'], 'standalone compile')
  const intent = record(compile.intent, 'standalone intent')
  fields(intent, ['request'], 'standalone intent')
  text(intent.request, 'intent.request')
  validateGraph(compile.graph)
  const typed = request as unknown as StandaloneRlmStartRequest
  const graph = typed.compile.graph
  const node = graph.nodes[0]
  if (node === undefined || graph.nodes.length !== 1 || graph.maxParallel !== 1 || graph.risk !== 'low'
    || (graph.workspaceIsolation !== undefined && graph.workspaceIsolation !== 'shared')
    || graph.qualityPolicy !== undefined || graph.baseSha !== undefined || graph.workspaceSnapshotLimits !== undefined
    || node.dependsOn.length !== 0 || ! node.requiredForCompletion
    || node.generationLimits !== undefined || node.workspaceToolLimits !== undefined || node.autonomous !== undefined
    || node.capabilityRequirements.length !== 0 || node.capabilityBudget.length !== 0
    || node.writeScopes.length !== 0 || node.approvedSecretRefs.length !== 0
    || node.effectBudget.write.length !== 0 || node.effectBudget.execute.length !== 0 || node.effectBudget.network.length !== 0
    || node.acceptance.some(item => item.kind !== 'operator-completed')
    || node.rlm?.mode !== 'enabled'
    || ![node.rlm.maxDepth, node.rlm.maxChildren, node.rlm.maxTurns].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new OrchestrationError('standalone first slice requires one read-only text RLM leaf with explicit recursion limits', 'GRAPH_INVALID')
  }
  if (node.operator?.preferredIds?.length !== 1 || node.operator.preferredIds[0] !== driver.operatorId
    || (node.operator.fallbackIds?.length ?? 0) !== 0
    || node.operator.profile?.model !== driver.model || node.operator.profile?.effort !== driver.effort) {
    throw new OrchestrationError('standalone graph must lock the exact driver/model/effort without fallback', 'GRAPH_INVALID')
  }
  const prompt = standaloneRlmPrompt(typed)
  if (node.task !== prompt.map(block => block.text).join('\n') || intent.request !== node.task) {
    throw new OrchestrationError('standalone compilation must preserve the exact rendered input', 'GRAPH_INVALID')
  }
  return structuredClone(typed)
}

/**
 * Materialize the frozen input once, preserving every raw text block when no envelope exists.
 * @param request - validated standalone input.
 * @returns exact original blocks, or the existing canonical envelope text representation.
 */
export function standaloneRlmPrompt(request: StandaloneRlmStartRequest): readonly { readonly type: 'text'; readonly text: string }[] {
  const envelope = request.input.contextEnvelope
  return envelope === undefined
    ? request.input.prompt as readonly { readonly type: 'text'; readonly text: string }[]
    : [{ type: 'text', text: renderOperatorContextEnvelopeText(envelope) }]
}
