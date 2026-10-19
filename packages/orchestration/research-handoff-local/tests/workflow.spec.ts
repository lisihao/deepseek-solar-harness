import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchOwnerId, ResearchRunId, ResearchWorkflowDefinitionInput } from '@deepseek-ai/dsh-research-handoff/api'
import { ResearchActionStore } from '../src/action-store.ts'

const closes: Array<() => void> = []
afterEach(() => { for (const close of closes.splice(0).reverse()) close() })
type Stage = ResearchWorkflowDefinitionInput['stages'][number]
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const owner = 'host-owner' as ResearchOwnerId, runId = 'same-run' as ResearchRunId
const question = '\ufeff原问题😀 $&\n完整尾部\n'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'research-workflow-')), file = join(dir, 'research.sqlite')
  closes.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const store = new ResearchActionStore(file)
  closes.push(() => { store.close() })
  store.create(owner, runId, { questionSha256: hash(question), sourcesSha256: 'explicit-source-config',
    modeSha256: 'gemini-mode', destinationSha256: 'gemini-target', plan: null })
  const platform = (name: string) => ({ driverId: name as ResearchWorkflowDefinitionInput['gemini']['driverId'], target: { workspace: 'fixture', page: name, conversation: null },
    selection: { model: 'fake-only', mode: name, effort: { kind: 'not-requested' }, tools: ['web'] }, destinationSha256: name })
  const input = { workflowId: 'canonical' as ResearchWorkflowDefinitionInput['workflowId'], sessionId: 'original-session', question, sourcesSha256: 'explicit-source-config',
    gemini: platform('gemini'), chatgpt: platform('chatgpt'), templateVersions: { gemini: '1.0', chatgpt: '1.0' },
    values: { gemini: { user_question: [question], scope: ['原文'] }, chatgpt: { user_question: [question] } },
    stages: ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].map((kind, i) => ({
      kind,
      actionId: ('action-' + String(i)) as Stage['actionId'],
      stepId: ('step-' + String(i)) as Stage['stepId'],
      preparedPromptId: i === 0 || i === 3 ? ('prompt-' + String(i)) as Stage['preparedPromptId'] : null,
    })) } as ResearchWorkflowDefinitionInput
  return { dir, file, store, input }
}

describe('canonical standard workflow in the existing SQLite owner', () => {
  it('retains full original input and reopens the same canonical identities', () => {
    const f = fixture()
    expect(f.store.workflows.read(owner, runId)).toBeNull()
    const first = f.store.workflows.claim(owner, runId, f.input)
    expect(first.input.question).toBe(question)
    expect(first.input.stages.map(x => x.actionId)).toEqual(f.input.stages.map(x => x.actionId))
    const second = new ResearchActionStore(f.file); closes.push(() => { second.close() })
    expect(second.workflows.read(owner, runId)).toEqual(first)
    expect(second.workflows.claim(owner, runId, structuredClone(f.input))).toEqual(first)
  })

  it('allows only one definition when two starts use separate SQLite connections', async () => {
    const f = fixture(), other = new ResearchActionStore(f.file); closes.push(() => { other.close() })
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => f.store.workflows.claim(owner, runId, f.input)),
      Promise.resolve().then(() => other.workflows.claim(owner, runId, { ...f.input, workflowId: 'other', sessionId: 'other-session' })),
    ])
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(x => x.status === 'rejected')).toHaveLength(1)
    expect(other.workflows.read(owner, runId)?.input).toEqual(f.store.workflows.read(owner, runId)?.input)
  })

  it.each(['workflowId', 'sessionId', 'values'] as const)('rejects replacement %s for the original run', (field) => {
    const f = fixture(); f.store.workflows.claim(owner, runId, f.input)
    const changed = { ...f.input, [field]: field === 'values'
      ? { ...f.input.values, gemini: { different: ['new text'] } } : 'replacement' }
    expect(() => f.store.workflows.claim(owner, runId, changed)).toThrow('canonical workflow or Session')
    expect(f.store.workflows.read(owner, runId)?.input).toEqual(f.input)
  })

  it('requires a new run to create a different canonical workflow', () => {
    const f = fixture(); f.store.workflows.claim(owner, runId, f.input)
    const id = 'explicit-new-run' as ResearchRunId
    const run = f.store.inspect(owner, runId)
    f.store.create(owner, id, run.binding)
    expect(f.store.workflows.claim(owner, id, { ...f.input, workflowId: 'new-workflow' }).runId).toBe(id)
    expect(f.store.workflows.read(owner, runId)?.input.workflowId).toBe('canonical')
  })

  it('does not use identifiers or hashes as owner access', () => {
    const f = fixture(); f.store.workflows.claim(owner, runId, f.input)
    const wrong = 'other-owner' as ResearchOwnerId
    expect(() => f.store.workflows.read(wrong, runId)).toThrow()
    expect(() => f.store.workflows.claim(wrong, runId, f.input)).toThrow()
    expect(() => f.store.workflows.claim(owner, runId, { ...f.input, question: 'changed' })).toThrow('original question')
  })

  it.each(['missing-stage', 'duplicate-action', 'no-prepared-prompt', 'lossy-unicode'])('rejects %s at the definition boundary', (bad) => {
    const f = fixture(), changed = structuredClone(f.input)
    const stages: Array<{ kind: string; actionId: string; stepId: string; preparedPromptId: string | null }>
      = changed.stages.map(x => ({ ...x }))
    Object.assign(changed, { stages })
    if (bad === 'missing-stage') stages.pop()
    if (bad === 'duplicate-action') stages[1]!.actionId = stages[0]!.actionId
    if (bad === 'no-prepared-prompt') stages[0]!.preparedPromptId = null
    if (bad === 'lossy-unicode') Object.assign(changed, { question: '\ud800' })
    expect(() => f.store.workflows.claim(owner, runId, changed)).toThrow()
    expect(f.store.workflows.read(owner, runId)).toBeNull()
  })

  it('rolls back a failed definition insert and does not change run confirmation', () => {
    const f = fixture(), db = new DatabaseSync(f.file); closes.push(() => { db.close() })
    const original = f.store.inspect(owner, runId)
    db.exec("CREATE TRIGGER fail_workflow BEFORE INSERT ON research_workflows BEGIN SELECT RAISE(ABORT,'injected workflow failure'); END")
    expect(() => f.store.workflows.claim(owner, runId, f.input)).toThrow('injected workflow failure')
    expect(f.store.workflows.read(owner, runId)).toBeNull()
    expect(f.store.inspect(owner, runId)).toEqual(original)
    db.exec('DROP TRIGGER fail_workflow')
    expect(f.store.workflows.claim(owner, runId, f.input).input).toEqual(f.input)
  })

  it('refuses durable definition edits even if an outer hash is recomputed', () => {
    const f = fixture(); f.store.workflows.claim(owner, runId, f.input)
    const db = new DatabaseSync(f.file); closes.push(() => { db.close() })
    const raw = JSON.stringify({ ...f.input, sessionId: 'other-session' })
    db.prepare('UPDATE research_workflows SET definition_json=?,sha256=? WHERE run_id=?').run(raw, hash(raw), runId)
    expect(() => f.store.workflows.read(owner, runId)).toThrow('durable canonical workflow')
  })

  it.each([15, 16, 17, 18])('refuses schema%s without rewriting the original database', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'research-old-')), file = join(dir, 'old.sqlite')
    closes.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const db = new DatabaseSync(file); db.exec('PRAGMA user_version=' + String(version)); db.close()
    const original = readFileSync(file)
    expect(() => new ResearchActionStore(file)).toThrow('unsupported research database version')
    expect(readFileSync(file)).toEqual(original)
  })
})
