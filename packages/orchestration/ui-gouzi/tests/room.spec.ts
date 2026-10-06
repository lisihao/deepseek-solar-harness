/** Exact source-session membership and current-attempt result attribution. */
import { describe, expect, it, vi } from 'vitest'
import { GouziId, OrchestrationArtifactRef, OrchestrationRunId, type GouziControl, type OrchestrationRunSnapshot, type OrchestrationService, type OrchestrationEvent } from '@deepseek-ai/dsh-orchestration'
import { PhysicalOperatorId } from '@deepseek-ai/dsh-physical-operator'
import { gouziRoom, gouziRoomEvidence } from '../src/room.ts'
import type { GouziDashboardV1 } from '../src/contracts.ts'

const dashboard: GouziDashboardV1 = { version: 1, generatedAt: 'now', limit: 10, used: 0, canManage: false, hostAvailable: false, hosts: [], members: [] }
const runId = OrchestrationRunId('run-1')
const ref = OrchestrationArtifactRef('evidence')
const planRef = OrchestrationArtifactRef('plan')
const run: OrchestrationRunSnapshot = {
  runId, title: 'Task', workspace: '/work', state: 'running', revision: 4, graphRevision: 1,
  admission: { policy: 'auto', route: 'taskgraph', sourceSessionId: 'session-a' },
  certificate: { version: 1, graphSha256: 'hash', certificateSha256: 'hash', nodeIds: ['node'], maximumRisk: 'low', requiresApproval: false, generatedAt: 'now' },
  nodes: [{ id: 'node', title: 'Node', role: 'worker', dependsOn: [], state: 'passed', attempt: 2, capabilityGeneration: 3, operatorId: 'actual.provider', executionPlanRef: planRef, evidenceRefs: [ref], blockers: [], updatedAt: 'now' }],
  blockers: [], createdAt: 'then', updatedAt: 'now',
}
const event: OrchestrationEvent = {
  sequence: 5, runId, nodeId: 'node', attempt: 2, generation: 3, type: 'node.evidence.accepted', time: '2026-10-06T03:00:00.000Z',
  data: { operatorId: 'actual.provider', evidenceRef: String(ref), outputPreview: 'Actual output' },
}
const plan = { version: 1, runId: String(runId), nodeId: 'node', attempt: 2, capabilityGeneration: 3, operatorPlan: { operatorId: 'actual.provider' } }

function fixture(runs: OrchestrationRunSnapshot[] = [run], log: OrchestrationEvent[] = [event], artifact: unknown = plan) {
  const readArtifact = vi.fn((requested: string) => Promise.resolve(requested === String(planRef) ? artifact : { output: 'Actual evidence' }))
  const list = vi.fn(() => Promise.resolve(runs))
  const readEvents = vi.fn(({ afterSequence }: { afterSequence?: number }) => Promise.resolve({
    events: afterSequence === 0 ? log : [], nextSequence: log.at(-1)?.sequence ?? 0,
  }))
  const service = { list, readArtifact, readEvents } as unknown as OrchestrationService
  const execution = [{ gouziId: GouziId('member'), generation: 8, operators: [{ operatorId: 'actual.provider', available: false, models: ['native'], unavailableReason: 'signed out' }] }]
  const control = { executionOperators: vi.fn(() => Promise.resolve(execution)) } as unknown as GouziControl
  return { service, control, readArtifact, execution, list }
}

describe('Gouzi room', () => {
  it('filters strictly by admission and preserves fresh availability without mutation', async () => {
    const { admission: _admission, ...legacy } = run
    const f = fixture([run, { ...run, runId: OrchestrationRunId('other'), admission: { ...run.admission!, sourceSessionId: 'session-b' } }, { ...legacy, runId: OrchestrationRunId('legacy') }])
    const room = await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)
    expect(room.roomPollIntervalMs).toBe(250)
    expect(room.tasks).toHaveLength(1)
    expect(room.execution).toEqual(f.execution)
    expect(room.tasks[0]!.nodes[0]).toMatchObject({ gouziId: 'member', result: { time: event.time, sequence: 5, accepted: true, operatorId: 'actual.provider' } })
    expect(await gouziRoom(f.service, f.control, 'empty', dashboard, 250)).toMatchObject({ tasks: [] })
  })
  it.each([{ attempt: 1 }, { generation: 2 }, { data: { ...event.data, operatorId: 'wrong' } }, { data: { code: 'FAILED' } }])('omits stale or unattributable results: %j', async (patch) => {
    const f = fixture([run], [{ ...event, ...patch }])
    expect((await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).tasks[0]!.nodes[0]!.result).toBeUndefined()
  })
  it.each([null, {}, { ...plan, attempt: 1 }, { ...plan, capabilityGeneration: 2 }, { ...plan, nodeId: 'other' }, { ...plan, operatorPlan: { operatorId: 'wrong' } }])('does not trust invalid durable plan JSON: %j', async (artifact) => {
    const f = fixture([run], [event], artifact)
    expect((await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).tasks[0]!.nodes[0]!.result).toBeUndefined()
  })
  it('selects current failure output and never lets a newer old-attempt event replace it', async () => {
    const f = fixture([run], [{ ...event, type: 'node.failed' }, { ...event, sequence: 6, attempt: 1 }])
    expect((await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).tasks[0]!.nodes[0]!.result).toMatchObject({ sequence: 5, accepted: false })
  })
  it('preserves unknown scheduler states and omits ambiguous member identity', async () => {
    const unknown = { ...run, state: 'future-state', nodes: [{ ...run.nodes[0]!, state: 'future-node' }] } as unknown as OrchestrationRunSnapshot
    const f = fixture([unknown])
    f.execution.push({ ...f.execution[0]!, gouziId: GouziId('second') })
    const room = await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)
    expect(room.tasks[0]!.state).toBe('future-state')
    expect(room.tasks[0]!.nodes[0]).toMatchObject({ state: 'future-node', result: { operatorId: 'actual.provider' } })
    expect(room.tasks[0]!.nodes[0]!.gouziId).toBeUndefined()
  })
  it('keeps a sealed recipient attribution when the original execution registration has retired', async () => {
    const f = fixture([{ ...run, admission: { ...run.admission!, gouziRecipient: { gouziId: GouziId('retired-member'), generation: 4, operatorIds: [PhysicalOperatorId('actual.provider')] } } }])
    f.execution.length = 0
    expect((await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).tasks[0]!.nodes[0]).toMatchObject({ gouziId: 'retired-member', result: { time: event.time, operatorId: 'actual.provider' } })
  })
  it('does not attribute a sealed result to a recipient whose recorded operators exclude it', async () => {
    const f = fixture([{ ...run, admission: { ...run.admission!, gouziRecipient: { gouziId: GouziId('wrong-member'), generation: 4, operatorIds: [PhysicalOperatorId('other.provider')] } } }])
    f.execution.length = 0
    expect((await gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).tasks[0]!.nodes[0]!.gouziId).toBeUndefined()
  })
  it('returns only retained evidence within this room and never reads a rejected artifact', async () => {
    const f = fixture()
    expect(await gouziRoomEvidence(f.service, 'session-b', String(runId), String(ref))).toBeUndefined()
    expect(await gouziRoomEvidence(f.service, 'session-a', String(runId), 'unretained')).toBeUndefined()
    expect(f.readArtifact).not.toHaveBeenCalled()
    expect(await gouziRoomEvidence(f.service, 'session-a', String(runId), String(ref))).toEqual({ output: 'Actual evidence' })
  })
  it('surfaces scheduler read failures', async () => {
    const f = fixture()
    f.list.mockRejectedValue(new Error('unknown outcome'))
    await expect(gouziRoom(f.service, f.control, 'session-a', dashboard, 250)).rejects.toThrow('unknown outcome')
  })
})
