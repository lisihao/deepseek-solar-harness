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

function optionalPositiveInteger(value: unknown, name: string, maximum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)) {
    throw new OrchestrationError(`${name} must be a positive integer no greater than ${String(maximum)}`, 'GRAPH_INVALID')
  }
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
  if (graph.baseSha !== undefined && !/^[a-f0-9]{7,64}$/iu.test(graph.baseSha)) {
    throw new OrchestrationError('graph.baseSha must be a 7 to 64 character hexadecimal Git id', 'GRAPH_INVALID')
  }
  if (graph.workspaceIsolation !== undefined && !['shared', 'git-worktree'].includes(graph.workspaceIsolation)) {
    throw new OrchestrationError('graph.workspaceIsolation is unsupported', 'GRAPH_INVALID')
  }
  if (graph.workspaceIsolation === 'git-worktree' && graph.baseSha === undefined) {
    throw new OrchestrationError('git-worktree isolation requires graph.baseSha', 'GRAPH_INVALID')
  }
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
    if (node.forbiddenScopes !== undefined) {
      stringArray(node.forbiddenScopes, `graph.nodes[${String(index)}].forbiddenScopes`)
    }
    if (node.requiredArtifacts !== undefined) {
      stringArray(node.requiredArtifacts, `graph.nodes[${String(index)}].requiredArtifacts`)
    }
    if (node.timeoutMs !== undefined
      && (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1_000 || node.timeoutMs > 86_400_000)) {
      throw new OrchestrationError(`node ${node.id} timeoutMs must be from 1000 through 86400000`, 'GRAPH_INVALID')
    }
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
    if (candidate.autonomous !== undefined) {
      if (!isRecord(candidate.autonomous) || !['auto', 'enabled', 'disabled'].includes(node.autonomous?.mode ?? '')) {
        throw new OrchestrationError(`node ${node.id} autonomous mode is unsupported`, 'GRAPH_INVALID')
      }
      optionalPositiveInteger(node.autonomous?.maxContinuations, `node ${node.id} autonomous maxContinuations`, 64)
      optionalPositiveInteger(node.autonomous?.maxTurns, `node ${node.id} autonomous maxTurns`, 256)
      optionalPositiveInteger(node.autonomous?.maxTokens, `node ${node.id} autonomous maxTokens`, 10_000_000)
      optionalPositiveInteger(node.autonomous?.timeoutMs, `node ${node.id} autonomous timeoutMs`, 86_400_000)
      if (node.autonomous?.continuationPrompt !== undefined
        && (node.autonomous.continuationPrompt.trim().length === 0
          || node.autonomous.continuationPrompt !== node.autonomous.continuationPrompt.trim()
          || node.autonomous.continuationPrompt.length > 12_000)) {
        throw new OrchestrationError(`node ${node.id} autonomous continuationPrompt is invalid`, 'GRAPH_INVALID')
      }
      if (node.autonomous?.gates !== undefined) {
        if (!isRecord(node.autonomous.gates)) {
          throw new OrchestrationError(`node ${node.id} autonomous gates must be an object`, 'GRAPH_INVALID')
        }
        stringArray(node.autonomous.gates.commands, `node ${node.id} autonomous gates.commands`)
        if (node.autonomous.gates.commands.length > 16 || node.autonomous.gates.commands.some(command => command.length > 4_096)) {
          throw new OrchestrationError(`node ${node.id} autonomous gates exceed the command budget`, 'GRAPH_INVALID')
        }
        optionalPositiveInteger(node.autonomous.gates.maxRetries, `node ${node.id} autonomous gates.maxRetries`, 20)
        optionalPositiveInteger(node.autonomous.gates.timeoutMs, `node ${node.id} autonomous gates.timeoutMs`, 3_600_000)
        if (node.autonomous.gates.commands.length > 0
          && !node.effectBudget.execute.some(effect => effect === '*' || effect === 'autonomous-gate')) {
          throw new OrchestrationError(
            `node ${node.id} autonomous shell gates require the autonomous-gate execute effect`,
            'GRAPH_INVALID',
          )
        }
      }
      if (node.autonomous !== undefined && node.autonomous.mode !== 'disabled' && node.rlm?.mode === 'disabled') {
        throw new OrchestrationError(`node ${node.id} cannot enable Autonomous Mode while RLM is disabled`, 'GRAPH_INVALID')
      }
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
  if (graph.qualityPolicy !== undefined) {
    if (!isRecord(graph.qualityPolicy)
      || !['required', 'advisory'].includes(graph.qualityPolicy.independentVerification)) {
      throw new OrchestrationError('graph.qualityPolicy.independentVerification is unsupported', 'GRAPH_INVALID')
    }
    if (graph.qualityPolicy.independentVerification === 'required') {
      const verificationNodes = graph.nodes.filter(node => node.phase === 'verification' && node.requiredForCompletion)
      if (verificationNodes.length === 0) {
        throw new OrchestrationError('strict quality policy requires a completion-critical verification node', 'GRAPH_INVALID')
      }
      for (const node of graph.nodes.filter(node => (
        node.phase !== 'verification'
        && (node.writeScopes.length > 0 || node.effectBudget.write.length > 0)
      ))) {
        if (!verificationNodes.some(verifier => dependsTransitively(graph, verifier.id, node.id))) {
          throw new OrchestrationError(
            `mutating node ${node.id} has no dependent completion-critical verification node`,
            'GRAPH_INVALID',
          )
        }
      }
    }
  }
  return order
}

/**
 * Test whether one node transitively depends on another node.
 * @param graph - validated logical TaskGraph.
 * @param nodeId - dependent node identity.
 * @param dependencyId - candidate transitive dependency identity.
 * @returns whether the dependency is reachable from the node.
 */
export function dependsTransitively(graph: LogicalTaskGraphV1, nodeId: string, dependencyId: string): boolean {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const pending = [...(byId.get(nodeId)?.dependsOn ?? [])]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    if (current === dependencyId) return true
    seen.add(current)
    pending.push(...(byId.get(current)?.dependsOn ?? []))
  }
  return false
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
