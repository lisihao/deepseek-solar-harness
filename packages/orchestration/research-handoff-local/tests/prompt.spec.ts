import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionId, ResearchActionRequest, ResearchArtifactId, ResearchDriverId, ResearchDriverRequest,
  ResearchDriverQualification, ResearchDriverReceipt, ResearchHostPolicy, ResearchOwnerId,
  ResearchPromptId, ResearchPromptInputId, ResearchPromptPreparation, ResearchRunId,
  ResearchStepId } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'
import { parseResearchPreparedPrompt, readResearchPromptTemplate, readResearchReferenceAsset } from '../src/prompt.ts'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const owner = 'owner' as ResearchOwnerId
const runId = 'run' as ResearchRunId
const question = '原始问题：<scope> 不得再次替换；保留 $&、中😀文和结尾\n'
const target = { workspace: 'fixture', page: 'original', conversation: null }
const inputId = 'prepared-original' as ResearchPromptInputId
const source = { page: target.page, conversation: null, method: 'manual-import' as const,
  capturedAt: '2026-10-18T00:00:00.000Z', extent: 'complete' as const, endEvidence: 'explicit fake report end' }
const resource = { ...target, report: 'fixture-report', evidence: 'explicit fake acceptance for original action' }

function preparation(templateId: ResearchPromptId = 'gemini-deep-research'): ResearchPromptPreparation {
  const slots = [...readResearchPromptTemplate(templateId).text.matchAll(/<([a-z_]+)>/g)].map(match => match[1]!)
  return { inputId, revision: 1, templateId, values: Object.fromEntries(slots.map(name =>
    [name, [{ kind: 'text' as const, text: name === 'user_question' ? question : '明确提供的 ' + name }]])) }
}

describe('versioned original research prompt preparation', () => {
  let directory: string
  let filename: string
  let store: ResearchActionStore
  let request: ResearchActionRequest
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'research-prompt-'))
    filename = join(directory, 'private.sqlite')
    store = new ResearchActionStore(filename)
    const run = store.create(owner, runId, { questionSha256: hash(question), sourcesSha256: 'public-only',
      modeSha256: 'fixture-mode', destinationSha256: 'original-destination', plan: null })
    request = { runId, actionId: 'original' as ResearchActionId, stepId: 'gemini-plan' as ResearchStepId,
      revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256,
      driverId: 'fake' as ResearchDriverId, selection: { model: 'fake', mode: 'fake', effort: { kind: 'not-requested' }, tools: [] },
      kind: 'gemini-plan-submit', target, preparedPromptId: null, input: 'direct fixture input' }
  })
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

  it.each([
    ['prompts_01_gemini_deep_research.zh.txt', '83e6f50b9bb15caf1386e4f0d6e81cd219b4657e011e382da71d577ae6c76e68'],
    ['prompts_02_chatgpt_verify_synthesize.zh.txt', '8be75a3d1f9530b7f950753684a2629c5d46a2562ef44936e28e72748ecc8100'],
    ['prompts_03_handoff_contract.zh.md', 'bc8d1b92220076928dfbf9e320719b8f859f8461635b7958abf54ef673a35f9c'],
    ['prompts_04_research_basis.zh.md', 'a5dccc820c70dcda5a123411ecfb3fabf17526300ddb8e45eeacab93237eb3b1'],
  ] as const)('retains the exact original asset %s', (name, sha256) => {
    const original = readResearchReferenceAsset(name)
    expect(original.sha256).toBe(sha256)
    expect(hash(original.text)).toBe(sha256)
  })

  it('renders each original slot once, retaining inserted slot-like bytes and original template suffix', () => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    expect(prepared.renderedText).toContain('用户原始问题：\n' + question)
    expect(prepared.renderedText).toContain('地域、对象、版本及时间范围：明确提供的 scope')
    expect(prepared.renderedText).toContain('<scope> 不得再次替换；保留 $&、中😀文')
    expect(prepared.renderedText.endsWith(readResearchPromptTemplate('gemini-deep-research').text.split('【完成前自检】')[1]!)).toBe(true)
    expect(prepared.renderedSha256).toBe(hash(prepared.renderedText))
    expect(store.inspect(owner, runId).confirmed).toBe(false)
  })

  it.each(['missing', 'unexpected'] as const)('rejects %s slots without inventing values', (variant) => {
    const input = preparation()
    const values = { ...input.values }
    if (variant === 'missing') delete values.scope
    else values.extra = [{ kind: 'text', text: 'not a slot' }]
    expect(() => store.preparePrompt(owner, runId, { ...input, values })).toThrow('slots')
    expect(() => store.readPreparedPrompt(owner, runId, inputId)).toThrow('not found')
  })

  it('rejects an original question different from the run binding and lossy UTF-8', () => {
    const input = preparation()
    expect(() => store.preparePrompt(owner, runId, { ...input, values: { ...input.values,
      user_question: [{ kind: 'text', text: 'replacement question' }] } })).toThrow('original Host question')
    expect(() => store.preparePrompt(owner, runId, { ...input, values: { ...input.values,
      scope: [{ kind: 'text', text: '\ud800' }] } })).toThrow('UTF-8')
  })

  it('persists full prepared input before a Driver callback and reopens unknown without replay', async () => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    store.confirm(owner, runId, request.revision, request.bindingSha256)
    const exact = { ...request, input: prepared.renderedText, preparedPromptId: inputId }
    const observer = new ResearchActionStore(filename)
    const invoke = vi.fn(async () => {
      expect(observer.readPreparedPrompt(owner, runId, inputId)).toEqual(prepared)
      expect(observer.readAction(owner, runId, exact.actionId).request).toEqual(exact)
      throw Error('fake transport result unknown')
    })
    try { await expect(store.execute(owner, exact, invoke)).rejects.toThrow('unknown') }
    finally { observer.close() }
    store.close()
    store = new ResearchActionStore(filename)
    expect(store.readPreparedPrompt(owner, runId, inputId)).toEqual(prepared)
    expect((await store.execute(owner, exact, invoke)).state).toBe('unknown')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retains immutable input identity, original revision and owner after a later revision', () => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    expect(store.preparePrompt(owner, runId, preparation())).toEqual(prepared)
    const changed = preparation()
    expect(() => store.preparePrompt(owner, runId, { ...changed, values: { ...changed.values,
      scope: [{ kind: 'text', text: 'changed scope' }] } })).toThrow('immutable')
    expect(() => store.readPreparedPrompt('other' as ResearchOwnerId, runId, inputId)).toThrow('another owner')
    store.revise(owner, runId, 1, request.binding)
    expect(store.readPreparedPrompt(owner, runId, inputId).revision).toBe(1)
    expect(() => store.preparePrompt(owner, runId, preparation())).toThrow('revision changed')
  })

  it.each(['text', 'stage', 'identity'] as const)('rejects action %s mismatches before a Driver callback', async (variant) => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    store.confirm(owner, runId, 1, request.bindingSha256)
    const exact: ResearchActionRequest = { ...request, input: prepared.renderedText, preparedPromptId: inputId }
    const changed = variant === 'text' ? { ...exact, input: prepared.renderedText + 'extra' }
      : variant === 'stage' ? { ...exact, kind: 'chatgpt-submit' as const }
        : { ...exact, preparedPromptId: 'missing' as ResearchPromptInputId }
    const invoke = vi.fn(async () => ({ state: 'accepted' as const, receipt: 'fake', acceptedResource: resource }))
    await expect(store.execute(owner, changed, invoke)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    expect(() => store.readAction(owner, runId, request.actionId)).toThrow('not found')
  })

  it('includes complete owner-readable artifact bytes and version in the second-stage input', async () => {
    store.confirm(owner, runId, 1, request.bindingSha256)
    await store.execute(owner, { ...request, kind: 'gemini-research-start' }, async () =>
      ({ state: 'completed', receipt: 'fake complete', acceptedResource: resource }))
    const bytes = new TextEncoder().encode('完整报告\n<user_question> is material, not a slot\n结束😀')
    const artifact = store.captureArtifact(owner, runId, { artifactId: 'report' as ResearchArtifactId,
      actionId: request.actionId, role: 'gemini-report', expectedVersion: 0, source, bytes })
    const input = preparation('chatgpt-verify-synthesize')
    const values = { ...input.values, handoff_manifest_and_artifacts: [{ kind: 'text' as const, text: '原始材料：\n' },
      { kind: 'artifact' as const, artifactId: artifact.artifactId, sha256: artifact.sha256 }] }
    const prepared = store.preparePrompt(owner, runId, { ...input, values })
    expect(prepared.renderedText).toContain('原始材料：\n' + new TextDecoder().decode(bytes))
    const second: ResearchActionRequest = { ...request, actionId: 'second-stage' as ResearchActionId,
      stepId: 'chatgpt-submit' as ResearchStepId, kind: 'chatgpt-submit', preparedPromptId: inputId, input: prepared.renderedText }
    await store.execute(owner, second, async (recorded) => {
      expect(recorded.input).toContain(new TextDecoder().decode(bytes))
      expect(store.readPreparedPrompt(owner, runId, inputId)).toEqual(prepared)
      return { state: 'completed', receipt: 'fake second-stage receipt', acceptedResource: resource }
    })
    expect(prepared.values.handoff_manifest_and_artifacts![1]).toMatchObject({ kind: 'artifact', version: 1,
      sha256: artifact.sha256, text: new TextDecoder().decode(bytes) })
    expect(() => store.preparePrompt(owner, runId, { ...input, inputId: 'changed' as ResearchPromptInputId,
      values: { ...values, handoff_manifest_and_artifacts: [{ kind: 'artifact', artifactId: artifact.artifactId, sha256: 'wrong' }] } }))
      .toThrow('artifact changed')
    expect(() => store.preparePrompt(owner, runId, { ...input, inputId: 'missing' as ResearchPromptInputId,
      values: { ...values, handoff_manifest_and_artifacts: [{ kind: 'artifact', artifactId: 'missing' as ResearchArtifactId,
        sha256: artifact.sha256 }] } })).toThrow('not found')
  })

  it.each(['template', 'text', 'digest', 'identity'] as const)('refuses corrupted durable %s even with a replaced row digest', (variant) => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    const changed = structuredClone(prepared)
    if (variant === 'template') Object.assign(changed.template, { version: 'invented' })
    if (variant === 'text') Object.assign(changed, { renderedText: 'truncated' })
    if (variant === 'identity') Object.assign(changed, { inputId: 'other' })
    const raw = JSON.stringify(changed)
    const db = new DatabaseSync(filename)
    db.prepare('UPDATE research_prepared_prompts SET prepared_json=?,sha256=? WHERE run_id=? AND input_id=?')
      .run(raw, variant === 'digest' ? 'corrupt' : hash(raw), runId, inputId)
    db.close()
    expect(() => store.readPreparedPrompt(owner, runId, inputId)).toThrow()
  })

  it('refuses imported template and rendered-value changes without treating them as authority', () => {
    const prepared = store.preparePrompt(owner, runId, preparation())
    expect(() => parseResearchPreparedPrompt({ ...prepared, values: { ...prepared.values,
      scope: [{ kind: 'text', text: 'changed' }] } })).toThrow('exact text')
  })
})

it('uses the current Host preparation channel and sends exact prepared text only through the fake Driver', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-prompt-host-'))
  const ctx = new Context()
  try {
    await ctx.plugin(provider, { filename: join(directory, 'private.sqlite') })
    const id = 'fake-gemini' as ResearchDriverId
    const selection = { model: 'fake', mode: 'fake-research', effort: { kind: 'not-requested' as const }, tools: [] }
    const policy: ResearchHostPolicy = { version: 'fixture', judgmentChannel: 'human', ownerId: owner,
      workspace: target.workspace, sourceConfigurationSha256s: ['public-only'],
      destinations: [{ bindingSha256: 'destination', target }], drivers: [{ id, platform: 'gemini', selection }], inputMaxBytes: 100000 }
    const registration = ctx.researchHandoff.bindHost(ctx, policy)
    const host = registration.control
    const run = host.create(runId, { questionSha256: hash(question), sourcesSha256: 'public-only', destinationSha256: 'destination',
      modeSha256: host.modeFingerprint(id), plan: null })
    const prepared = host.preparePrompt(runId, preparation())
    host.confirm(runId, run.revision, run.bindingSha256)
    const qualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => {
      expect(host.readPreparedPrompt(runId, inputId)).toEqual(prepared)
      expect(host.readAction(runId, input.request.actionId).state).toBe('unknown')
      return { status: 'available', requestSha256: input.requestSha256, target, selection,
        effort: { kind: 'not_observed' }, inputMaxBytes: 100000, evidence: 'fake interface' }
    })
    const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal,
      beforeSubmit: () => void): Promise<ResearchDriverReceipt> => {
      beforeSubmit()
      expect(input.request.input).toBe(prepared.renderedText)
      expect(input.request.preparedPromptId).toBe(inputId)
      return { state: 'accepted', receipt: 'fake only', acceptedResource: resource, requestSha256: input.requestSha256, target }
    })
    ctx.researchHandoff.registerDriver(ctx, { id, platform: 'gemini', qualify, execute,
      observe: async input => ({ state: 'unknown', requestSha256: input.requestSha256, target, receipt: null }) })
    const result = await host.execute({ runId, actionId: 'original' as ResearchActionId, stepId: 'gemini-plan' as ResearchStepId,
      revision: run.revision, bindingSha256: run.bindingSha256, binding: run.binding, driverId: id, selection,
      kind: 'gemini-plan-submit', target, input: prepared.renderedText, preparedPromptId: inputId })
    expect(result.state).toBe('accepted')
    expect(execute).toHaveBeenCalledTimes(1)
    await registration.dispose()
    expect(() => host.readPreparedPrompt(runId, inputId)).toThrow('revoked')
  }
  finally { await ctx.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
