import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchOwnerId, ResearchRunId, ResearchWorkflowDefinitionInput, ResearchWorkflowPreviewInput,
  ResearchActionRequest, ResearchPromptPreparation, ResearchJudgmentAttribution, ResearchArtifactId } from '@deepseek-ai/dsh-research-handoff/api'
import { ResearchActionStore, researchModeFingerprint } from '../src/action-store.ts'
import { readResearchPromptTemplate, renderResearchPrompt } from '../src/prompt.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
type Stage = ResearchWorkflowDefinitionInput['stages'][number]
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const owner = 'owner' as ResearchOwnerId, runId = 'run' as ResearchRunId
const question = '\ufeff完整原问题😀 $&\n尾部\n'
const human: ResearchJudgmentAttribution = { channel: 'human', ownerId: owner, hostPolicyVersion: 'fake-human-entry' }

function textValues(values: ResearchPromptPreparation['values']) {
  return Object.fromEntries(Object.entries(values).map(([key, parts]) => [key, parts.map((part) => {
    if (part.kind !== 'text') throw new Error('fixture requires explicit text slots')
    return part
  })]))
}

function fixture(tools: string[] = ['web']) {
  const directory = mkdtempSync(join(tmpdir(), 'research-preview-')), filename = join(directory, 'research.sqlite')
  cleanup.push(() => { rmSync(directory, { recursive: true, force: true }) })
  const store = new ResearchActionStore(filename)
  cleanup.push(() => { store.close() })
  const template = readResearchPromptTemplate('gemini-deep-research')
  const values = Object.fromEntries([...template.text.matchAll(/<([a-z_]+)>/g)].map(x =>
    [x[1]!, [x[1] === 'user_question' ? question : 'explicit ' + x[1]!]]))
  const platform = (id: string) => ({ driverId: id as ResearchWorkflowDefinitionInput['gemini']['driverId'], selection: { model: 'fake', mode: id,
    effort: { kind: 'not-requested' }, tools }, target: { workspace: 'fixture', page: id, conversation: null },
  destinationSha256: id + '-destination' })
  const input = { workflowId: 'canonical' as ResearchWorkflowDefinitionInput['workflowId'], sessionId: 'same-session', question, sourcesSha256: 'sources',
    gemini: platform('gemini'), chatgpt: platform('chatgpt'), templateVersions: { gemini: template.version, chatgpt: '1.0' },
    values: { gemini: values, chatgpt: { user_question: [question] } },
    stages: ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].map((kind, i) => ({
      kind,
      actionId: ('action-' + String(i)) as Stage['actionId'],
      stepId: ('step-' + String(i)) as Stage['stepId'],
      preparedPromptId: i === 0 || i === 3 ? ('prompt-' + String(i)) as Stage['preparedPromptId'] : null,
    })) } as ResearchWorkflowDefinitionInput
  const run = store.create(owner, runId, { questionSha256: hash(question), sourcesSha256: 'sources',
    modeSha256: researchModeFingerprint(input.gemini.driverId, input.gemini.selection),
    destinationSha256: input.gemini.destinationSha256, plan: null })
  store.workflows.claim(owner, runId, input)
  const stage = input.stages[0]!
  const prompt: ResearchPromptPreparation = { inputId: stage.preparedPromptId!, revision: run.revision, templateId: template.id,
    values: Object.fromEntries(Object.entries(values).map(([key, parts]) => [key, parts.map(text => ({ kind: 'text' as const, text }))])) }
  const request: ResearchActionRequest = { runId, actionId: stage.actionId, stepId: stage.stepId, revision: run.revision,
    binding: run.binding, bindingSha256: run.bindingSha256, driverId: input.gemini.driverId, selection: input.gemini.selection,
    target: input.gemini.target, kind: stage.kind,
    input: renderResearchPrompt(template, textValues(prompt.values)), preparedPromptId: prompt.inputId }
  const preview: ResearchWorkflowPreviewInput = { previewId: 'preview' as ResearchWorkflowPreviewInput['previewId'],
    workflowId: input.workflowId, request, prompt, artifactIds: [] }
  const confirmRun = () => {
    const current = store.inspect(owner, runId)
    store.confirm(owner, runId, current.revision, current.bindingSha256)
  }
  const confirm = () => { confirmRun(); const p = store.workflowPreviews.create(owner, runId, preview)
    return store.workflowPreviews.confirm(owner, runId, preview.previewId, p.sha256, human) }
  return { store, filename, run, input, request, prompt, preview, confirm, confirmRun }
}

describe('complete immutable workflow previews in real SQLite', () => {
  it('uses the original action normalization when tool order differs but the full request is unchanged', async () => {
    const f = fixture(['web', 'files']), p = f.confirm()
    const fixed = f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)
    expect(fixed.selection.tools).toEqual(['files', 'web'])
    const accepted = await f.store.execute(owner, fixed, async (actual) => {
      expect(actual).toEqual(fixed)
      return { state: 'accepted', receipt: 'fake actual', acceptedResource: { ...actual.target,
        conversation: 'same-original', report: null, evidence: 'fake exact accepted resource' } }
    })
    expect(accepted.request).toEqual(fixed)
  })
  it('retains exact original full input without preparing or admitting the fixed stage', () => {
    const f = fixture(), p = f.store.workflowPreviews.create(owner, runId, f.preview)
    expect(p.input.request.input).toBe(f.request.input)
    expect(p.input.preparedPrompt?.values.user_question).toEqual([{ kind: 'text', text: question }])
    expect(p.confirmed).toBe(false)
    expect(() => f.store.readPreparedPrompt(owner, runId, f.prompt.inputId)).toThrow('not found')
    expect(() => f.store.readAction(owner, runId, f.request.actionId)).toThrow('not found')
    expect(f.store.workflowPreviews.create(owner, runId, f.preview)).toEqual(p)
  })

  it('does not invalidate its digest when the exact run is separately confirmed', () => {
    const f = fixture(), first = f.store.workflowPreviews.create(owner, runId, f.preview)
    f.confirmRun()
    const after = f.store.workflowPreviews.read(owner, runId, f.preview.previewId)
    expect(after.sha256).toBe(first.sha256)
    expect(after.input).toEqual(first.input)
    expect(after.isCurrent).toBe(true)
    expect(after.confirmed).toBe(false)
    expect(f.store.workflowPreviews.confirm(owner, runId, f.preview.previewId, after.sha256, human).confirmed).toBe(true)
  })

  it('requires run confirmation and exact preview digest before a separate attributed confirmation', () => {
    const f = fixture(), p = f.store.workflowPreviews.create(owner, runId, f.preview)
    expect(() => f.store.workflowPreviews.confirm(owner, runId, p.input.previewId, p.sha256, human)).toThrow('not current')
    f.confirmRun()
    expect(() => f.store.workflowPreviews.confirm(owner, runId, p.input.previewId, 'wrong', human)).toThrow('not current')
    expect(() => f.store.workflowPreviews.confirm(owner, runId, p.input.previewId, p.sha256, { ...human, channel: 'imported' })).toThrow()
    expect(f.store.workflowPreviews.read(owner, runId, p.input.previewId).confirmation).toBeNull()
  })

  it('freezes the original template atomically without creating or executing an action', () => {
    const f = fixture(), p = f.confirm()
    const fixed = f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)
    expect(fixed).toEqual(f.request)
    expect(f.store.readPreparedPrompt(owner, runId, f.prompt.inputId).renderedText).toBe(f.request.input)
    expect(() => f.store.readAction(owner, runId, f.request.actionId)).toThrow('not found')
    expect(f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)).toEqual(fixed)
  })

  it('rejects stale preview before consuming prepared or action identities and preserves its history', () => {
    const f = fixture(), p = f.confirm()
    f.store.revise(owner, runId, f.run.revision, f.run.binding)
    expect(f.store.workflowPreviews.read(owner, runId, p.input.previewId)).toMatchObject({ isCurrent: false, confirmed: false })
    expect(() => f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)).toThrow('cannot freeze')
    expect(() => f.store.readPreparedPrompt(owner, runId, f.prompt.inputId)).toThrow('not found')
    expect(() => f.store.readAction(owner, runId, f.request.actionId)).toThrow('not found')
    expect(f.store.workflowPreviews.read(owner, runId, p.input.previewId).confirmation).toEqual(p.confirmation)
  })

  it('restores exact preview bytes and confirmation through a separate SQLite connection', () => {
    const f = fixture(), p = f.confirm(), other = new ResearchActionStore(f.filename)
    cleanup.push(() => { other.close() })
    expect(other.workflowPreviews.read(owner, runId, p.input.previewId)).toEqual(p)
    expect(other.workflowPreviews.create(owner, runId, f.preview)).toEqual(p)
    expect(other.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)).toEqual(f.request)
  })

  it('rejects immutable preview ID replacement after a revision but permits an explicit new preview before freezing', () => {
    const f = fixture(); f.store.workflowPreviews.create(owner, runId, f.preview)
    const run = f.store.revise(owner, runId, f.run.revision, f.run.binding)
    const changed = { ...f.preview, request: { ...f.request, revision: run.revision }, prompt: { ...f.prompt, revision: run.revision } }
    expect(() => f.store.workflowPreviews.create(owner, runId, changed)).toThrow('immutable workflow preview')
    expect(f.store.workflowPreviews.create(owner, runId, { ...changed, previewId: 'new-preview' as typeof changed.previewId }).isCurrent).toBe(true)
  })

  it('keeps a frozen prepared ID unavailable to a different preview revision', () => {
    const f = fixture(), p = f.confirm(); f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)
    const run = f.store.revise(owner, runId, f.run.revision, f.run.binding)
    expect(() => f.store.workflowPreviews.create(owner, runId, { ...f.preview, previewId: 'changed' as typeof p.input.previewId,
      request: { ...f.request, revision: run.revision }, prompt: { ...f.prompt, revision: run.revision } })).toThrow('no longer current')
    expect(f.store.readPreparedPrompt(owner, runId, f.prompt.inputId).revision).toBe(f.run.revision)
  })

  it('rolls back a failed prompt write without changing original preview confirmation', () => {
    const f = fixture(), p = f.confirm(), db = new DatabaseSync(f.filename)
    cleanup.push(() => { db.close() })
    db.exec("CREATE TRIGGER fail_prepare BEFORE INSERT ON research_prepared_prompts BEGIN SELECT RAISE(ABORT,'injected prepare failure'); END")
    expect(() => f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)).toThrow('injected prepare failure')
    expect(() => f.store.readPreparedPrompt(owner, runId, f.prompt.inputId)).toThrow('not found')
    expect(f.store.workflowPreviews.read(owner, runId, p.input.previewId).confirmation).toEqual(p.confirmation)
    db.exec('DROP TRIGGER fail_prepare')
    expect(f.store.workflowPreviews.freeze(owner, runId, p.input.previewId, p.sha256)).toEqual(f.request)
  })

  it('rejects another owner, stage, original slot text or imported completion flags', () => {
    const f = fixture(), p = f.store.workflowPreviews.create(owner, runId, f.preview)
    expect(() => f.store.workflowPreviews.read('other' as ResearchOwnerId, runId, p.input.previewId)).toThrow()
    expect(() => f.store.workflowPreviews.create(owner, runId, { ...f.preview, request: { ...f.request, stepId: 'other' as typeof f.request.stepId } })).toThrow()
    const changed = structuredClone(f.preview), values = { ...f.prompt.values }
    const key = Object.keys(values).find(x => x !== 'user_question')!
    values[key] = [{ kind: 'text', text: 'changed original intent' }]
    const template = readResearchPromptTemplate('gemini-deep-research')
    Object.assign(changed, { prompt: { ...f.prompt, values },
      request: { ...f.request, input: renderResearchPrompt(template, textValues(values)) } })
    expect(() => f.store.workflowPreviews.create(owner, runId, changed)).toThrow('original slot')
    const imported = { ...f.preview, confirmed: true }
    expect(f.store.workflowPreviews.create(owner, runId, imported).confirmed).toBe(false)
  })

  it('rejects changed durable full text even when its outer hash is recomputed', () => {
    const f = fixture(), p = f.confirm(), db = new DatabaseSync(f.filename)
    cleanup.push(() => { db.close() })
    const raw = JSON.stringify({ ...p.input, request: { ...p.input.request, input: 'truncated' } })
    db.prepare('UPDATE research_workflow_previews SET input_json=?,sha256=? WHERE run_id=? AND preview_id=?')
      .run(raw, hash(raw), runId, p.input.previewId)
    expect(() => f.store.workflowPreviews.read(owner, runId, p.input.previewId)).toThrow()
  })

  it('refuses an ordinary artifact without the preceding canonical collection and delivery chain', async () => {
    const f = fixture(); f.confirmRun()
    const stage = f.input.stages[1]!
    const source = { ...f.request, actionId: stage.actionId, stepId: stage.stepId, kind: stage.kind, preparedPromptId: null }
    const action = await f.store.execute(owner, source, async () => ({ state: 'completed', receipt: 'fake original complete',
      acceptedResource: { ...source.target, conversation: 'original', report: 'report', evidence: 'fake original' } }))
    const capture = (id: string, expectedVersion: number, value: string) => f.store.captureArtifact(owner, runId, {
      artifactId: id as ResearchArtifactId, actionId: action.request.actionId, expectedVersion, role: 'gemini-report',
      source: { page: 'gemini', conversation: 'original', method: 'dom-text', capturedAt: '2026-10-18T00:00:00Z',
        extent: 'complete', endEvidence: 'original end' }, bytes: Buffer.from(value) })
    const report = capture('report-1', 0, '\ufeff全文😀 $&\n尾部\n')
    const run = f.store.revise(owner, runId, f.run.revision, { ...f.run.binding,
      modeSha256: researchModeFingerprint(f.input.chatgpt.driverId, f.input.chatgpt.selection),
      destinationSha256: f.input.chatgpt.destinationSha256 })
    const upload = f.input.stages[2]!
    const request: ResearchActionRequest = { ...f.request, actionId: upload.actionId, stepId: upload.stepId, revision: run.revision,
      binding: run.binding, bindingSha256: run.bindingSha256, driverId: f.input.chatgpt.driverId, selection: f.input.chatgpt.selection,
      kind: upload.kind, target: f.input.chatgpt.target, preparedPromptId: null, input: Buffer.from(report.bytes).toString() }
    expect(() => f.store.workflowPreviews.create(owner, runId, { ...f.preview, request, prompt: null,
      artifactIds: [report.artifactId] })).toThrow('exact canonical collected material')
    expect(() => f.store.readAction(owner, runId, upload.actionId)).toThrow('not found')
  })
})
