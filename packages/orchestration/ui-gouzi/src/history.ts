/** What a kennel Session has already dispatched, and how its collaborations ended, read back from the Session log. */
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

/**
 * Read the final text of each node of a run.
 * @param service - authoritative scheduler reads.
 * @param run - run whose events are read.
 * @returns the newest accepted or failed result per node that has output text.
 */
export async function runResults(service: OrchestrationService, run: OrchestrationRunSnapshot): Promise<KennelCollaborationResult[]> {
  const latest = new Map<string, KennelCollaborationResult>()
  let afterSequence = 0
  for (;;) {
    const page = await service.readEvents({ runId: run.runId, afterSequence, limit: 500 })
    if (page.events.length === 0) return [...latest.values()]
    if (page.nextSequence <= afterSequence) throw new Error('orchestration event cursor did not advance')
    for (const event of page.events) {
      if ((event.type === 'node.evidence.accepted' || event.type === 'node.failed') && event.nodeId !== undefined
        && typeof event.data.outputPreview === 'string') {
        latest.set(event.nodeId, { nodeId: event.nodeId, accepted: event.type === 'node.evidence.accepted', text: event.data.outputPreview })
      }
    }
    afterSequence = page.nextSequence
  }
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
