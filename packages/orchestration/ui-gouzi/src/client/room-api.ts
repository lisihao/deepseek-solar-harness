/** Authenticated read-only room and evidence transport. */
import { GOUZI_AVATARS, GOUZI_ROLE_IDS, GOUZI_STATE_COPY, GOUZI_DASHBOARD_PATH, GOUZI_ROOM_POLL_INTERVAL_SCHEMA, type GouziRoomSnapshotV1 } from '../contracts.ts'
import type { BrowserRequest } from './api.ts'
async function read(request: BrowserRequest, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(GOUZI_DASHBOARD_PATH, window.location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await request(url, { cache: 'no-store', ...(signal ? { signal } : {}) })
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : `狗窝读取失败 (${response.status})`)
  return body
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string') }
function isoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false
  const date = value.slice(0, 10)
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
}
/** A collaboration is shown by kind, run, state, and the members with their roles. */
function validCollaborations(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every((entry: unknown) =>
    record(entry) && id(entry.collaboration) && typeof entry.label === 'string' && id(entry.runId) && typeof entry.state === 'string'
    && (entry.subject === undefined || record(entry.subject) && id(entry.subject.runId) && typeof entry.subject.title === 'string')
    && (entry.outcome === undefined || record(entry.outcome) && typeof entry.outcome.label === 'string'
      && ['pending', 'positive', 'negative', 'unclear'].includes(String(entry.outcome.state)))
    && Array.isArray(entry.members) && entry.members.every((member: unknown) => record(member) && id(member.gouziId)
      && typeof member.role === 'string' && typeof member.roleLabel === 'string'
      && (member.conclusion === undefined || typeof member.conclusion === 'string')
      && (member.text === undefined || typeof member.text === 'string')))
}

/** Collaboration outcomes on a task are optional; each one must carry its kind, run, state, and label. */
function validOutcomes(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every((outcome: unknown) =>
    record(outcome) && id(outcome.collaboration) && id(outcome.runId) && typeof outcome.label === 'string'
    && ['pending', 'positive', 'negative', 'unclear'].includes(String(outcome.state)))
}

function validRoom(value: unknown, sessionId: string): value is GouziRoomSnapshotV1 {
  if (!record(value) || !integer(value.roomPollIntervalMs) || value.roomPollIntervalMs <= 0 || value.version !== 1 || value.sessionId !== sessionId || typeof value.generatedAt !== 'string'
    || !record(value.dashboard) || !Array.isArray(value.dashboard.members)
    || !Array.isArray(value.execution) || !Array.isArray(value.tasks)) return false
  const members = value.dashboard.members.every((member: unknown) => record(member) && id(member.gouziId)
    && typeof member.name === 'string' && typeof member.hostLabel === 'string' && id(member.hostId)
    && GOUZI_AVATARS.some(v => v === member.avatarId) && GOUZI_ROLE_IDS.some(v => v === member.role)
    && typeof member.state === 'string' && Object.hasOwn(GOUZI_STATE_COPY, member.state)
    && ['provisioning', 'enabled', 'retiring', 'archived'].includes(String(member.membership))
    && ['online', 'unreachable'].includes(String(member.connection)))
  const execution = value.execution.every((entry: unknown) => record(entry) && id(entry.gouziId)
    && integer(entry.generation) && entry.generation > 0 && strings(entry.projectScopes)
    && entry.projectScopes.every(id) && Array.isArray(entry.operators)
    && entry.operators.every((operator: unknown) => record(operator) && id(operator.operatorId)
      && typeof operator.available === 'boolean'
      && (operator.supportsGenerationLimits === undefined || typeof operator.supportsGenerationLimits === 'boolean')
      && (operator.supportsGovernedWorkspacePolicy === undefined || typeof operator.supportsGovernedWorkspacePolicy === 'boolean')
      && strings(operator.models)))
  const tasks = value.tasks.every((task: unknown) => record(task) && id(task.runId) && typeof task.title === 'string'
    && typeof task.state === 'string' && integer(task.revision) && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string' && validOutcomes(task.outcomes)
    && Array.isArray(task.nodes) && task.nodes.every((node: unknown) => {
    if (!record(node) || !id(node.nodeId) || typeof node.title !== 'string' || typeof node.state !== 'string'
        || !integer(node.attempt) || !integer(node.capabilityGeneration) || !strings(node.evidenceRefs)
        || node.gouziId !== undefined && !id(node.gouziId) || node.operatorId !== undefined && !id(node.operatorId)) return false
    if (node.result === undefined) return true
    return record(node.result) && integer(node.result.sequence) && id(node.result.evidenceRef)
        && isoTime(node.result.time)
        && typeof node.result.outputPreview === 'string' && typeof node.result.accepted === 'boolean'
        && id(node.result.operatorId) && node.result.operatorId === node.operatorId
  }))
  return members && execution && tasks && validCollaborations(value.collaborations)
}
/**
 * Read the exact session room, rejecting invalid wire fields before they can authorize a send.
 * @param request - authenticated reader.
 * @param sessionId - source session.
 * @param signal - cancellation.
 * @returns validated room DTO.
 */
export async function loadKennelRoom(request: BrowserRequest, sessionId: string, signal?: AbortSignal): Promise<GouziRoomSnapshotV1> {
  const value = await read(request, { session_id: sessionId }, signal)
  if (!validRoom(value, sessionId)) throw new Error('Invalid kennel room reply')
  const interval = await GOUZI_ROOM_POLL_INTERVAL_SCHEMA['~standard'].validate(value.roomPollIntervalMs)
  if (interval.issues) throw new Error('Invalid kennel room polling interval')
  return value
}
/**
 * Read actual evidence for an admitted run.
 * @param request - authenticated reader.
 * @param sessionId - source session.
 * @param runId - admitted run.
 * @param ref - evidence reference.
 * @param signal - cancellation owned by the calling plugin.
 * @returns actual evidence.
 */
export function readKennelEvidence(
  request: BrowserRequest, sessionId: string, runId: string, ref: string, signal?: AbortSignal,
): Promise<unknown> {
  return read(request, { session_id: sessionId, run_id: runId, evidence_ref: ref }, signal)
}
