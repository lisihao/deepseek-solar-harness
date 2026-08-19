/** Pure TaskGraph validation, readiness, and conflict algorithms. */
import { OrchestrationError, type LogicalTaskGraphV1, type OrchestrationNodeSpecV1, type PlanCertificateV1 } from '@deepseek-ai/dsh-orchestration'
import { canonicalSha256 } from './canonical.ts'

function requiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new OrchestrationError(`${name} must be non-blank and trimmed`, 'GRAPH_INVALID')
  }
}

function stringArray(value: unknown, name: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry)) {
    throw new OrchestrationError(`${name} must contain non-blank trimmed strings`, 'GRAPH_INVALID')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one untrusted graph at the durable/wire boundary.
 * @param value - untrusted version-one logical graph.
 * @returns the deterministic topological node order.
 */
export function validateGraph(value: unknown): string[] {
  if (!isRecord(value) || value.version !== 1) {
    throw new OrchestrationError('graph version must be 1', 'GRAPH_INVALID')
  }
  const graph = value as unknown as LogicalTaskGraphV1
  requiredString(graph.title, 'graph.title')
  requiredString(graph.workspace, 'graph.workspace')
  if (!Number.isSafeInteger(graph.maxParallel) || graph.maxParallel < 1 || graph.maxParallel > 64) {
    throw new OrchestrationError('graph.maxParallel must be an integer from 1 through 64', 'GRAPH_INVALID')
  }
  if (!['low', 'medium', 'high'].includes(graph.risk)) {
    throw new OrchestrationError('graph.risk is unsupported', 'GRAPH_INVALID')
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new OrchestrationError('graph.nodes must contain at least one node', 'GRAPH_INVALID')
  }
  const byId = new Map<string, OrchestrationNodeSpecV1>()
  for (const [index, candidate] of value.nodes.entries()) {
    if (!isRecord(candidate)) {
      throw new OrchestrationError(`graph.nodes[${String(index)}] must be an object`, 'GRAPH_INVALID')
    }
    const node = candidate as unknown as OrchestrationNodeSpecV1
    requiredString(node.id, `graph.nodes[${String(index)}].id`)
    requiredString(node.title, `graph.nodes[${String(index)}].title`)
    requiredString(node.task, `graph.nodes[${String(index)}].task`)
    requiredString(node.role, `graph.nodes[${String(index)}].role`)
    if (byId.has(node.id)) throw new OrchestrationError(`duplicate graph node id: ${node.id}`, 'GRAPH_INVALID')
    stringArray(node.dependsOn, `graph.nodes[${String(index)}].dependsOn`)
    stringArray(node.capabilityBudget, `graph.nodes[${String(index)}].capabilityBudget`)
    stringArray(node.readScopes, `graph.nodes[${String(index)}].readScopes`)
    stringArray(node.writeScopes, `graph.nodes[${String(index)}].writeScopes`)
    stringArray(node.approvedSecretRefs, `graph.nodes[${String(index)}].approvedSecretRefs`)
    if (!isRecord(candidate.retryPolicy)) {
      throw new OrchestrationError(`node ${node.id} retryPolicy must be an object`, 'GRAPH_INVALID')
    }
    if (!Number.isSafeInteger(node.retryPolicy.maxAttempts) || node.retryPolicy.maxAttempts < 1 || node.retryPolicy.maxAttempts > 20) {
      throw new OrchestrationError(`node ${node.id} retry maxAttempts must be from 1 through 20`, 'GRAPH_INVALID')
    }
    if (!Number.isSafeInteger(node.retryPolicy.backoffMs) || node.retryPolicy.backoffMs < 0 || node.retryPolicy.backoffMs > 86_400_000) {
      throw new OrchestrationError(`node ${node.id} retry backoffMs is invalid`, 'GRAPH_INVALID')
    }
    if (!isRecord(candidate.contextPolicy)
      || !Number.isSafeInteger(node.contextPolicy.maxTokens)
      || node.contextPolicy.maxTokens < 1) {
      throw new OrchestrationError(`node ${node.id} context maxTokens must be positive`, 'GRAPH_INVALID')
    }
    byId.set(node.id, node)
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) throw new OrchestrationError(`node ${node.id} depends on itself`, 'GRAPH_CYCLE')
      if (!byId.has(dependency)) throw new OrchestrationError(`node ${node.id} has unknown dependency ${dependency}`, 'GRAPH_INVALID')
    }
  }
  const indegree = new Map(graph.nodes.map(node => [node.id, node.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      const values = dependents.get(dependency) ?? []
      values.push(node.id)
      dependents.set(dependency, values)
    }
  }
  const ready = graph.nodes.filter(node => node.dependsOn.length === 0).map(node => node.id).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  if (order.length !== graph.nodes.length) throw new OrchestrationError('graph contains a dependency cycle', 'GRAPH_CYCLE')
  return order
}

/**
 * Build the immutable Plan Certificate fields from a validated graph.
 * @param graph - validated logical TaskGraph.
 * @returns the content-verifiable plan certificate.
 */
export function graphCertificate(graph: LogicalTaskGraphV1): PlanCertificateV1 {
  const order = validateGraph(graph)
  const graphSha256 = canonicalSha256(graph)
  const fields = {
    version: 1 as const,
    graphSha256,
    nodeIds: order,
    maximumRisk: graph.risk,
    requiresApproval: graph.risk !== 'low',
  }
  return {
    ...fields,
    certificateSha256: canonicalSha256(fields),
    generatedAt: new Date().toISOString(),
  }
}

function normalizedScope(value: string): string {
  if (value === '*') return value
  return value.replace(/\/+$/u, '') || '/'
}

/**
 * Return whether two scope declarations overlap hierarchically.
 * @param left - first normalized or hierarchical scope.
 * @param right - second normalized or hierarchical scope.
 * @returns whether either scope contains the other.
 */
export function scopeOverlap(left: string, right: string): boolean {
  const a = normalizedScope(left)
  const b = normalizedScope(right)
  return a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Return whether two nodes cannot run concurrently under certified authority.
 * @param left - first node specification.
 * @param right - second node specification.
 * @returns whether the Scheduler must serialize the nodes.
 */
export function nodesConflict(left: OrchestrationNodeSpecV1, right: OrchestrationNodeSpecV1): boolean {
  if (left.writeScopes.some(a => right.writeScopes.some(b => scopeOverlap(a, b)))) return true
  if (left.writeScopes.some(a => right.readScopes.some(b => scopeOverlap(a, b)))) return true
  if (right.writeScopes.some(a => left.readScopes.some(b => scopeOverlap(a, b)))) return true
  const exclusive = (node: OrchestrationNodeSpecV1): string[] => [
    ...node.effectBudget.execute,
    ...node.effectBudget.network,
    ...node.effectBudget.risk.filter(value => value.startsWith('exclusive:')),
  ]
  const rightEffects = new Set(exclusive(right))
  return exclusive(left).some(effect => rightEffects.has(effect) || effect === '*' || rightEffects.has('*'))
}
