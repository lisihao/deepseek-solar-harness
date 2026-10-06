/** Read-only projection of source-session tasks and their current sealed execution results. */
import { OrchestrationArtifactRef, type GouziControl, type OrchestrationService, type OrchestrationEvent, type OrchestrationNodeSnapshot, type OrchestrationRunSnapshot } from '@deepseek-ai/dsh-orchestration'
import type { GouziDashboardV1, GouziRoomNodeV1, GouziRoomSnapshotV1 } from './contracts.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function events(service: OrchestrationService, run: OrchestrationRunSnapshot): Promise<OrchestrationEvent[]> {
  const collected: OrchestrationEvent[] = []
  let afterSequence = 0
  for (;;) {
    const page = await service.readEvents({ runId: run.runId, afterSequence, limit: 500 })
    if (page.events.length === 0) return collected
    if (page.nextSequence <= afterSequence) throw new Error('orchestration event cursor did not advance')
    collected.push(...page.events)
    afterSequence = page.nextSequence
  }
}

async function projectNode(service: OrchestrationService, run: OrchestrationRunSnapshot, node: OrchestrationNodeSnapshot, log: readonly OrchestrationEvent[], execution: GouziRoomSnapshotV1['execution']): Promise<GouziRoomNodeV1> {
  const projected: GouziRoomNodeV1 = {
    nodeId: node.id, title: node.title, state: node.state, attempt: node.attempt,
    capabilityGeneration: node.capabilityGeneration, evidenceRefs: node.evidenceRefs.map(String),
    ...node.operatorId === undefined ? {} : { operatorId: node.operatorId },
    ...node.executionPlanRef === undefined ? {} : { executionPlanRef: String(node.executionPlanRef) },
  }
  if (node.executionPlanRef === undefined) return projected
  const plan = object(await service.readArtifact(node.executionPlanRef))
  const operator = object(plan?.operatorPlan)
  // Artifact JSON must prove the exact current attempt before it can attribute output.
  if (plan?.version !== 1 || plan.runId !== String(run.runId) || plan.nodeId !== node.id
    || plan.attempt !== node.attempt || plan.capabilityGeneration !== node.capabilityGeneration
    || typeof operator?.operatorId !== 'string' || operator.operatorId.length === 0
    || node.operatorId !== operator.operatorId) return projected
  const result = log.filter(event => event.runId === run.runId && event.nodeId === node.id
    && event.attempt === node.attempt && event.generation === node.capabilityGeneration
    && (event.type === 'node.evidence.accepted' || event.type === 'node.failed'))
    .sort((left, right) => left.sequence - right.sequence).at(-1)
  if (result === undefined || result.data.operatorId !== operator.operatorId
    || typeof result.data.evidenceRef !== 'string' || !projected.evidenceRefs.includes(result.data.evidenceRef)
    || typeof result.data.outputPreview !== 'string') return projected
  const members = execution.filter(member => member.operators.some(value => value.operatorId === operator.operatorId))
  const member = members.length === 1 ? members.at(0) : undefined
  const recipient = run.admission?.gouziRecipient
  const gouziId = recipient?.operatorIds.some(id => String(id) === operator.operatorId)
    ? String(recipient.gouziId) : member?.gouziId
  return { ...projected, ...gouziId === undefined ? {} : { gouziId }, result: {
    time: result.time, sequence: result.sequence, evidenceRef: result.data.evidenceRef, outputPreview: result.data.outputPreview,
    accepted: result.type === 'node.evidence.accepted', operatorId: operator.operatorId,
  } }
}

/**
 * Project only tasks whose durable admission names this source session.
 * @param service - authoritative scheduler reads.
 * @param control - current execution registration query.
 * @param sessionId - explicit source session identity.
 * @param dashboard - authorized roster projection.
 * @param roomPollIntervalMs - validated Host read interval.
 * @returns current room data without starting or changing any work.
 */
export async function gouziRoom(
  service: OrchestrationService, control: GouziControl, sessionId: string, dashboard: GouziDashboardV1, roomPollIntervalMs: number,
): Promise<GouziRoomSnapshotV1> {
  const execution = (await control.executionOperators()).map(member => ({ ...member, gouziId: String(member.gouziId) }))
  const runs = (await service.list()).filter(run => run.admission?.sourceSessionId === sessionId)
  const tasks = await Promise.all(runs.map(async (run) => {
    const log = await events(service, run)
    return {
      runId: String(run.runId), title: run.title, state: run.state, revision: run.revision,
      createdAt: run.createdAt, updatedAt: run.updatedAt,
      nodes: await Promise.all(run.nodes.map(node => projectNode(service, run, node, log, execution))),
    }
  }))
  return { version: 1, sessionId, roomPollIntervalMs, generatedAt: dashboard.generatedAt, dashboard, execution, tasks }
}

/**
 * Read an artifact retained as node evidence by a run admitted in this source session.
 * @param service - authoritative scheduler reads.
 * @param sessionId - explicit source session identity.
 * @param runId - requested run identity.
 * @param evidenceRef - requested retained artifact identity.
 * @returns the actual artifact, or undefined when the room has no such retained reference.
 */
export async function gouziRoomEvidence(
  service: OrchestrationService, sessionId: string, runId: string, evidenceRef: string,
): Promise<unknown> {
  const run = (await service.list()).find(value => String(value.runId) === runId && value.admission?.sourceSessionId === sessionId)
  if (run === undefined || !run.nodes.some(node => node.evidenceRefs.some(ref => String(ref) === evidenceRef))) return undefined
  return service.readArtifact(OrchestrationArtifactRef(evidenceRef))
}
