import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchOwnerId, ResearchRunId, ResearchWorkflowDefinitionInput, ResearchActionRequest,
  ResearchWorkflowStage, ResearchArtifactId, ResearchWorkflowObservationId, ResearchActionSnapshot,
  ResearchJudgmentAttribution, ResearchWorkflowDeliveryDispositionInput,
  ResearchWorkflowPreviewInput, ResearchPromptPreparation } from '@deepseek-ai/dsh-research-handoff/api'
import { ResearchActionStore, researchModeFingerprint } from '../src/action-store.ts'
import { readResearchPromptTemplate } from '../src/prompt.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
type Stage = ResearchWorkflowDefinitionInput['stages'][number]
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const owner = 'owner' as ResearchOwnerId, runId = 'run' as ResearchRunId
const question = '\ufeff原问题😀 $&\n完整尾部\n'
const human: ResearchJudgmentAttribution = { channel: 'human', ownerId: owner, hostPolicyVersion: 'fake-human-entry' }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'research-delivery-gates-')), filename = join(directory, 'research.sqlite')
  cleanup.push(() => { rmSync(directory, { recursive: true, force: true }) })
  const store = new ResearchActionStore(filename)
  cleanup.push(() => { store.close() })
  const values = (id: 'gemini-deep-research' | 'chatgpt-verify-synthesize') => Object.fromEntries(
    [...new Set([...readResearchPromptTemplate(id).text.matchAll(/<([a-z_]+)>/g)].map(x => x[1]!))]
      .map(name => [name, [name === 'user_question' ? question : 'explicit ' + name]]))
  const platform = (id: string) => ({ driverId: id as ResearchWorkflowDefinitionInput['gemini']['driverId'], selection: { model: 'fake', mode: id,
    effort: { kind: 'not-requested' }, tools: ['web'] }, target: { workspace: 'fixture', page: id, conversation: null },
  destinationSha256: id + '-destination' })
  const definition = { workflowId: 'canonical' as ResearchWorkflowDefinitionInput['workflowId'], sessionId: 'same-session', question, sourcesSha256: 'sources',
    gemini: platform('gemini'), chatgpt: platform('chatgpt'), templateVersions: { gemini: '1.0', chatgpt: '1.0' },
    values: { gemini: values('gemini-deep-research'), chatgpt: values('chatgpt-verify-synthesize') },
    stages: ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].map((kind, i) => ({
      kind,
      actionId: ('action-' + String(i)) as Stage['actionId'],
      stepId: ('step-' + String(i)) as Stage['stepId'],
      preparedPromptId: i === 0 || i === 3 ? ('prompt-' + String(i)) as Stage['preparedPromptId'] : null,
    })) } as ResearchWorkflowDefinitionInput
  store.create(owner, runId, { questionSha256: hash(question), sourcesSha256: 'sources',
    modeSha256: researchModeFingerprint(definition.gemini.driverId, definition.gemini.selection),
    destinationSha256: definition.gemini.destinationSha256, plan: null })
  store.workflows.claim(owner, runId, definition)
  const prepare = (index: number, material?: ResearchArtifactId): ResearchActionRequest => {
    const stage = definition.stages[index]!, platform = index < 2 ? definition.gemini : definition.chatgpt
    const outputs = store.workflows.outputs(owner, runId, definition.workflowId)
    const original = outputs.filter(x => x.artifact.role === (index === 1 ? 'gemini-plan' : 'gemini-report')).at(-1)?.artifact
    const current = store.inspect(owner, runId)
    const binding = { ...current.binding, modeSha256: researchModeFingerprint(platform.driverId, platform.selection),
      destinationSha256: platform.destinationSha256,
      plan: index === 1 && original !== undefined ? { version: original.version, sha256: original.sha256 } : current.binding.plan }
    const revised = JSON.stringify(binding) === JSON.stringify(current.binding) ? current
      : store.revise(owner, runId, current.revision, binding)
    store.confirm(owner, runId, revised.revision, revised.bindingSha256)
    const previous = index === 1 || index === 3
      ? store.readAction(owner, runId, definition.stages[index - 1]!.actionId).acceptedResource : null
    let input = original === undefined ? '' : Buffer.from(original.bytes).toString('utf8')
    if (index === 0 || index === 3) {
      const templateId = index === 0 ? 'gemini-deep-research' : 'chatgpt-verify-synthesize'
      const slots = index === 0 ? definition.values.gemini : definition.values.chatgpt
      const promptValues: ResearchPromptPreparation['values'] = Object.fromEntries(Object.entries(slots).map(([key, texts]) => [key,
        key === 'handoff_manifest_and_artifacts' && original !== undefined
          ? [{ kind: 'artifact' as const, artifactId: material ?? original.artifactId, sha256: original.sha256 }]
          : texts.map(text => ({ kind: 'text' as const, text }))]))
      input = store.preparePrompt(owner, runId, { inputId: stage.preparedPromptId!, revision: revised.revision,
        templateId, values: promptValues }).renderedText
    }
    return { runId, actionId: stage.actionId, stepId: stage.stepId, kind: stage.kind, revision: revised.revision,
      binding: revised.binding, bindingSha256: revised.bindingSha256, driverId: platform.driverId, selection: platform.selection,
      preparedPromptId: stage.preparedPromptId, input, target: previous === null ? platform.target
        : { workspace: previous.workspace, page: previous.page, conversation: previous.conversation } }
  }
  const complete = async (index: number, modify?: (r: ResearchActionRequest) => ResearchActionRequest) => {
    const request = prepare(index), fixed = modify?.(request) ?? request
    return store.execute(owner, fixed, async () => ({ state: 'completed', receipt: 'fake completed ' + String(index),
      acceptedResource: { ...fixed.target, conversation: fixed.target.conversation ?? (index < 2 ? 'same-gemini' : 'same-chatgpt'),
        report: index === 1 || index === 3 ? 'original-report' : null, evidence: 'fake original resource' } }))
  }
  let clock = 0
  const observe = (action: ResearchActionSnapshot, value: string | null, partial = false) => store.deliveries.record(owner, runId,
    action.request.actionId, action.inputSha256, { kind: action.request.kind === 'chatgpt-upload' ? 'attachment' : 'message',
      externalId: 'same-item-' + action.request.actionId, observedAt: new Date(1800000000000 + clock++).toISOString(), evidence: 'fake read-back',
      readBack: value === null ? { kind: 'unavailable', reason: 'not readable' } : {
        kind: partial ? 'partial-text' : 'complete-text', text: value, evidence: 'fake full original read' } })
  const capture = (action: ResearchActionSnapshot, id: string, value: string, extent: 'complete' | 'partial' = 'complete') => {
    const resource = action.acceptedResource!
    return store.workflows.capture(owner, runId, definition.workflowId, { actionId: action.request.actionId,
      observationId: id as ResearchWorkflowObservationId, requestSha256: action.inputSha256, resource,
      source: { page: resource.page, conversation: resource.conversation, method: 'dom-text',
        capturedAt: '2026-10-18T00:00:00Z', extent, endEvidence: extent === 'complete' ? 'fake original end' : null }, bytes: Buffer.from(value) })
  }
  const prerequisites = (kind: ResearchWorkflowStage['kind']) => store.workflowDeliveries.prerequisites(owner, runId, kind)
  const disposition = (a: ResearchActionSnapshot, id = 'treatment', previous: string | null = null) => {
    const history = store.deliveries.read(owner, runId, a.request.actionId), correction = history.at(-1)!
    return { dispositionId: id as ResearchWorkflowDeliveryDispositionInput['dispositionId'], actionId: a.request.actionId,
      expectedPreviousId: previous as ResearchWorkflowDeliveryDispositionInput['expectedPreviousId'],
      negative: history.filter(x => x.contentStatus === 'mismatched').map(x => ({ seq: x.seq, sha256: x.sha256 })),
      correction: { seq: correction.seq, sha256: correction.sha256 }, reason: 'reviewed each original mismatch and exact subsequent same-item full read-back' } as ResearchWorkflowDeliveryDispositionInput
  }
  const plan = async () => { const a = await complete(0); observe(a, a.request.input); capture(a, 'plan', '\ufeff原计划😀\n尾部\n'); return a }
  const report = async () => { await plan(); const a = await complete(1); capture(a, 'report', '\ufeff完整原报告😀 $&\n尾部\n'); return a }
  return { store, filename, definition, prepare, complete, observe, capture, prerequisites, disposition, plan, report }
}

describe('standard delivery gates and precise negative-history treatments', () => {
  it('checks only previous stages, with three distinct full-delivery gates', async () => {
    const f = fixture()
    expect(f.prerequisites('gemini-plan-submit')).toMatchObject({ ready: true, stages: [] })
    expect(f.prerequisites('gemini-research-start').ready).toBe(false)
    const plan = await f.plan()
    expect(f.prerequisites('gemini-research-start').ready).toBe(true)
    const research = await f.complete(1)
    expect(f.prerequisites('chatgpt-upload').ready).toBe(false)
    f.capture(research, 'report', 'complete original report')
    expect(f.prerequisites('chatgpt-upload').ready).toBe(true)
    const upload = await f.complete(2)
    f.observe(upload, null)
    expect(f.prerequisites('chatgpt-submit').ready).toBe(false)
    f.observe(upload, upload.request.input)
    const before = f.prerequisites('chatgpt-submit')
    expect(before.ready).toBe(true)
    expect(before.stages.map(x => x.kind)).not.toContain('chatgpt-submit')
    const submit = await f.complete(3)
    expect(f.store.workflowDeliveries.read(owner, runId, submit.request.kind).deliveryVerified).toBe(false)
    f.observe(submit, submit.request.input)
    expect(f.store.workflowDeliveries.read(owner, runId, submit.request.kind).deliveryVerified).toBe(true)
    expect(f.prerequisites('chatgpt-submit')).toEqual(before)
    expect(plan.request.input).toContain(question)
  })

  it('supplements unreadable and partial history with a complete match of the same external item', async () => {
    const f = fixture(), a = await f.complete(0)
    f.capture(a, 'plan', 'full plan')
    f.observe(a, null); f.observe(a, a.request.input, true)
    expect(f.prerequisites('gemini-research-start').ready).toBe(false)
    f.observe(a, a.request.input)
    const basis = f.prerequisites('gemini-research-start')
    expect(basis.ready).toBe(true)
    expect(basis.stages[0]?.history.map(x => x.contentStatus)).toEqual(['not-read-back', 'not-read-back', 'matched'])
    f.observe(a, a.request.input); f.observe(a, null)
    expect(f.prerequisites('gemini-research-start').key).toBe(basis.key)
    expect(f.store.workflowDeliveries.prerequisites(owner, runId, 'gemini-research-start', basis)).toEqual(basis)
  })

  it('keeps a mismatch blocked after a later match until exact attributed human treatment', async () => {
    const f = fixture(), a = await f.complete(0)
    f.capture(a, 'plan', 'full plan')
    f.observe(a, 'truncated'); f.observe(a, a.request.input)
    expect(f.prerequisites('gemini-research-start').ready).toBe(false)
    const input = f.disposition(a)
    expect(() => f.store.workflowDeliveries.append(owner, runId, input, { ...human, channel: 'imported' })).toThrow('human')
    expect(() => f.store.workflowDeliveries.append(owner, runId, { ...input, negative: [{ ...input.negative[0]!, sha256: 'wrong' }] }, human)).toThrow('exact mismatches')
    const record = f.store.workflowDeliveries.append(owner, runId, input, human)
    expect(record.history).toHaveLength(2)
    expect(f.prerequisites('gemini-research-start').ready).toBe(true)
    expect(f.store.workflowDeliveries.append(owner, runId, input, human)).toEqual(record)
    f.observe(a, 'new mismatch'); f.observe(a, a.request.input)
    expect(f.prerequisites('gemini-research-start').ready).toBe(false)
    expect(f.store.workflowDeliveries.readTreatment(owner, runId, input.dispositionId)).toEqual(record)
    expect(f.store.workflowDeliveries.append(owner, runId, input, human)).toEqual(record)
    const next = f.disposition(a, 'treatment-2', 'treatment')
    expect(() => f.store.workflowDeliveries.append(owner, runId, { ...next, expectedPreviousId: null }, human)).toThrow('compare-and-swap')
    const other = new ResearchActionStore(f.filename); cleanup.push(() => { other.close() })
    other.workflowDeliveries.append(owner, runId, next, human)
    expect(f.prerequisites('gemini-research-start').ready).toBe(true)
    expect(() => f.store.workflowDeliveries.append(owner, runId, { ...next, dispositionId: 'racing' as typeof next.dispositionId }, human)).toThrow('compare-and-swap')
  })

  it('requires every negative record and a later full correction, retaining all earlier reasons', async () => {
    const f = fixture(), a = await f.complete(0)
    f.capture(a, 'plan', 'full plan')
    const first = f.observe(a, a.request.input)
    f.observe(a, 'bad-1'); f.observe(a, 'bad-2')
    const input = f.disposition(a)
    expect(() => f.store.workflowDeliveries.append(owner, runId, { ...input,
      correction: { seq: first.seq, sha256: first.sha256 } }, human)).toThrow('later same-item full match')
    f.observe(a, a.request.input)
    const latest = f.disposition(a)
    expect(() => f.store.workflowDeliveries.append(owner, runId, { ...latest, negative: latest.negative.slice(1) }, human)).toThrow('all exact mismatches')
    expect(f.store.workflowDeliveries.append(owner, runId, latest, human).history).toHaveLength(4)
  })

  it('invalidates a confirmed next-stage preview on new mismatch without consuming its action', async () => {
    const f = fixture(); await f.report()
    const request = f.prepare(2), output = f.store.workflows.outputs(owner, runId, f.definition.workflowId).at(-1)!
    const input: ResearchWorkflowPreviewInput = { previewId: 'upload-preview' as ResearchWorkflowPreviewInput['previewId'],
      workflowId: f.definition.workflowId, request, prompt: null, artifactIds: [output.artifact.artifactId] }
    const p = f.store.workflowPreviews.create(owner, runId, input)
    f.store.workflowPreviews.confirm(owner, runId, input.previewId, p.sha256, human)
    f.store.workflowPreviews.freeze(owner, runId, input.previewId, p.sha256)
    const plan = f.store.readAction(owner, runId, f.definition.stages[0]!.actionId)
    f.observe(plan, 'new negative')
    const stale = f.store.workflowPreviews.read(owner, runId, input.previewId)
    expect(stale).toMatchObject({ confirmed: false, isCurrent: false })
    expect(stale.input).toEqual(p.input)
    expect(() => f.store.workflowPreviews.freeze(owner, runId, input.previewId, p.sha256)).toThrow('cannot freeze')
    expect(() => f.store.readAction(owner, runId, request.actionId)).toThrow('not found')
  })

  it('retains confirmed preview bytes across benign new read-backs but rejects new collected versions', async () => {
    const f = fixture(), report = await f.report(), request = f.prepare(2)
    const artifact = f.store.workflows.outputs(owner, runId, f.definition.workflowId).at(-1)!.artifact
    const input: ResearchWorkflowPreviewInput = { previewId: 'upload-preview' as ResearchWorkflowPreviewInput['previewId'],
      workflowId: f.definition.workflowId, request, prompt: null, artifactIds: [artifact.artifactId] }
    const p = f.store.workflowPreviews.create(owner, runId, input)
    f.store.workflowPreviews.confirm(owner, runId, input.previewId, p.sha256, human)
    const plan = f.store.readAction(owner, runId, f.definition.stages[0]!.actionId)
    f.observe(plan, plan.request.input)
    expect(f.store.workflowPreviews.read(owner, runId, input.previewId)).toMatchObject({ confirmed: true, sha256: p.sha256 })
    expect(f.store.workflowPreviews.create(owner, runId, input).input).toEqual(p.input)
    f.capture(report, 'new-report', 'updated full report')
    const after = f.store.workflowPreviews.read(owner, runId, input.previewId)
    expect(after.confirmed).toBe(false)
    expect(after.input.prerequisites).toEqual(p.input.prerequisites)
    expect(after.input.materials[0]?.text).toBe(request.input)
  })

  it('does not accept a manual or newer partial artifact in place of the actual complete original output', async () => {
    const f = fixture(), report = await f.report()
    f.capture(report, 'partial-later', 'partial original', 'partial')
    expect(f.prerequisites('chatgpt-upload').ready).toBe(false)
    f.capture(report, 'full-later', 'complete original again')
    expect(f.prerequisites('chatgpt-upload').ready).toBe(true)
    const original = f.store.workflows.outputs(owner, runId, f.definition.workflowId).at(-1)!.artifact
    f.store.captureArtifact(owner, runId, { artifactId: 'manual' as ResearchArtifactId, actionId: report.request.actionId,
      role: 'gemini-report', expectedVersion: original.version, source: { ...original.source, method: 'manual-import' }, bytes: original.bytes })
    expect(f.prerequisites('chatgpt-upload').ready).toBe(false)
  })

  it('keeps the attachment and verification prompt tied to the original ChatGPT conversation', async () => {
    const f = fixture(); await f.report()
    const upload = await f.complete(2); f.observe(upload, upload.request.input)
    const submit = await f.complete(3, r => ({ ...r, target: { ...r.target, conversation: 'different' } }))
    f.observe(submit, submit.request.input)
    expect(f.store.workflowDeliveries.read(owner, runId, 'chatgpt-submit').blockers).toContain('original-input-unlinked')
  })

  it('rolls back a failed treatment insert and reopens immutable evidence without backfilling history', async () => {
    const f = fixture(), a = await f.complete(0)
    f.capture(a, 'plan', 'full plan'); f.observe(a, 'bad'); f.observe(a, a.request.input)
    const input = f.disposition(a), db = new DatabaseSync(f.filename); cleanup.push(() => { db.close() })
    db.exec("CREATE TRIGGER fail_treatment BEFORE INSERT ON research_workflow_delivery_dispositions BEGIN SELECT RAISE(ABORT,'injected treatment failure'); END")
    expect(() => f.store.workflowDeliveries.append(owner, runId, input, human)).toThrow('injected treatment failure')
    expect(f.prerequisites('gemini-research-start').ready).toBe(false)
    db.exec('DROP TRIGGER fail_treatment')
    const record = f.store.workflowDeliveries.append(owner, runId, input, human)
    f.observe(a, a.request.input)
    const other = new ResearchActionStore(f.filename); cleanup.push(() => { other.close() })
    expect(other.workflowDeliveries.readTreatment(owner, runId, input.dispositionId)).toEqual(record)
    expect(() => other.workflowDeliveries.readTreatment('wrong' as ResearchOwnerId, runId, input.dispositionId)).toThrow()
    const raw = JSON.stringify({ ...record, input: { ...record.input, correction: record.input.negative[0] } })
    const parsed = JSON.parse(raw) as Record<string, unknown>; delete parsed.sha256
    const tampered = JSON.stringify(parsed)
    db.prepare('UPDATE research_workflow_delivery_dispositions SET input_json=?,sha256=? WHERE run_id=?').run(tampered, hash(tampered), runId)
    expect(() => other.workflowDeliveries.readTreatment(owner, runId, input.dispositionId)).toThrow('invalid durable')
  })
})
