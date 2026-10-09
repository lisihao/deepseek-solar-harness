/** What a kennel Session has already dispatched, and how its collaborations ended, read back from the Session log. */
import { OrchestrationArtifactRef } from '@deepseek-ai/dsh-orchestration'
import type {
  KennelCollaborationKind,
  KennelCollaborationRecord,
  KennelCollaborationResult,
  KennelWorkRecord,
  OrchestrationRunSnapshot,
  OrchestrationService,
} from '@deepseek-ai/dsh-orchestration'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/**
 * Work tasks the dispatcher admitted, with the member offer that took each.
 * @param events - ordered Session events.
 * @returns one record per admitted work message, oldest first.
 */
export function workRecords(events: readonly SessionEvent[]): KennelWorkRecord[] {
  return events.flatMap((event): KennelWorkRecord[] => {
    if (event.type !== 'kennel/dispatch-admitted') return []
    const { messageId } = event.data
    const decision = events.find(value => value.type === 'kennel/dispatch-decision' && value.data.messageId === messageId)
    const request = events.find(value => value.type === 'kennel/dispatch-request' && value.data.messageId === messageId)
    if (decision?.type !== 'kennel/dispatch-decision' || request?.type !== 'kennel/dispatch-request') return []
    const chosen = request.data.candidates.find(candidate => candidate.id === decision.data.candidateId)
    if (chosen?.kind !== 'work') return []
    const { kind: _kind, ...offer } = chosen
    return [{ runId: event.data.runId, offer }]
  })
}

/**
 * Collaborations the dispatcher started.
 * @param events - ordered Session events.
 * @returns one record per admitted collaboration, oldest first.
 */
export function collaborationRecords(events: readonly SessionEvent[]): Omit<KennelCollaborationRecord, 'outcome'>[] {
  return events.flatMap((event) => {
    if (event.type !== 'kennel/dispatch-collaboration-admitted') return []
    const { messageId, collaboration, runId, assignments } = event.data
    const started = events.find(value => value.type === 'kennel/dispatch-collaboration' && value.data.messageId === messageId)
    return started?.type === 'kennel/dispatch-collaboration' ? [{ collaboration, runId, messageId, candidate: started.data.candidate, assignments }] : []
  })
}

/** Appended to a result whose complete text could not be read, so a cut-off reply is never taken for a whole one. */
export const TRUNCATED_RESULT_NOTE = '\n（以上内容被截断，未能读取完整文本）'

/** Text of a node's retained output: text blocks as written, any other block as JSON, as the scheduler's preview does. */
async function fullText(service: OrchestrationService, evidenceRef: string): Promise<string | undefined> {
  let evidence: unknown
  try { evidence = await service.readArtifact(OrchestrationArtifactRef(evidenceRef)) } catch {
    // The caller keeps the preview and marks it cut off, so an unreadable artifact must not fail the whole room read.
    return undefined
  }
  const output = (evidence as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return undefined
  return output.map((block: { type?: unknown; text?: unknown }) => (block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block))).join('\n')
}

/**
 * Read the final text of each node of a run. A reply the scheduler cut off in its event preview is read whole from the
 * node's retained output; when that cannot be read, the preview is kept and says it is cut off.
 * @param service - authoritative scheduler reads.
 * @param run - run whose events are read.
 * @returns the newest accepted or failed result per node that has output text.
 */
export async function runResults(service: OrchestrationService, run: OrchestrationRunSnapshot): Promise<KennelCollaborationResult[]> {
  const latest = new Map<string, KennelCollaborationResult>()
  const cutOff = new Map<string, string>()
  let afterSequence = 0
  for (;;) {
    const page = await service.readEvents({ runId: run.runId, afterSequence, limit: 500 })
    if (page.events.length === 0) break
    if (page.nextSequence <= afterSequence) throw new Error('orchestration event cursor did not advance')
    for (const event of page.events) {
      if ((event.type === 'node.evidence.accepted' || event.type === 'node.failed') && event.nodeId !== undefined
        && typeof event.data.outputPreview === 'string') {
        latest.set(event.nodeId, { nodeId: event.nodeId, accepted: event.type === 'node.evidence.accepted', text: event.data.outputPreview })
        if (event.data.outputTruncated === true) cutOff.set(event.nodeId, String(event.data.evidenceRef))
        else cutOff.delete(event.nodeId)
      }
    }
    afterSequence = page.nextSequence
  }
  return Promise.all([...latest.values()].map(async (result) => {
    const evidenceRef = cutOff.get(result.nodeId)
    if (evidenceRef === undefined) return result
    return { ...result, text: await fullText(service, evidenceRef) ?? `${result.text}${TRUNCATED_RESULT_NOTE}` }
  }))
}

/**
 * Read the collaborations a live Session started, with the outcomes their kinds report.
 * @param service - authoritative scheduler reads.
 * @param kinds - registered kinds.
 * @param events - ordered Session events.
 * @param sessionId - the Session's identity.
 * @returns the collaboration records, oldest first.
 */
export async function sessionCollaborations(
  service: OrchestrationService, kinds: readonly KennelCollaborationKind[], events: readonly SessionEvent[], sessionId: string,
): Promise<KennelCollaborationRecord[]> {
  const records = collaborationRecords(events)
  if (records.length === 0) return []
  const runs = (await service.list()).filter(run => run.admission?.sourceSessionId === sessionId)
  return withOutcomes(records, kinds, service, runs)
}

/**
 * Attach each collaboration's outcome, as the kind that started it reports from the run's current results.
 * @param records - collaborations to describe.
 * @param kinds - registered kinds.
 * @param service - authoritative scheduler reads.
 * @param runs - this Session's runs.
 * @returns the records, with an outcome where the kind reports one.
 */
export async function withOutcomes(
  records: readonly Omit<KennelCollaborationRecord, 'outcome'>[],
  kinds: readonly KennelCollaborationKind[],
  service: OrchestrationService,
  runs: readonly OrchestrationRunSnapshot[],
): Promise<KennelCollaborationRecord[]> {
  return Promise.all(records.map(async (record): Promise<KennelCollaborationRecord> => {
    const kind = kinds.find(value => value.kind === record.collaboration)
    const run = runs.find(value => String(value.runId) === record.runId)
    if (kind?.outcome === undefined || run === undefined) return record
    const outcome = kind.outcome(record, run, await runResults(service, run))
    return outcome === undefined ? record : { ...record, outcome }
  }))
}
