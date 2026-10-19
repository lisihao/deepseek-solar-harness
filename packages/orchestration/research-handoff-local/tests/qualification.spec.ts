import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionId, ResearchActionRequest, ResearchDriverId, ResearchDriverQualification,
  ResearchOwnerId, ResearchRunId, ResearchStepId } from '@deepseek-ai/dsh-research-handoff/api'
import { ResearchActionStore, researchActionFingerprint } from '../src/action-store.ts'

const owner = 'owner' as ResearchOwnerId
const runId = 'qualification-run' as ResearchRunId
const actionId = 'original-action' as ResearchActionId
const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'research-qualification-'))
  const filename = join(directory, 'qualification.sqlite')
  const opened = new Set<ResearchActionStore>()
  cleanups.push(() => { for (const store of opened) store.close(); rmSync(directory, { recursive: true, force: true }) })
  const open = () => { const store = new ResearchActionStore(filename); opened.add(store); return store }
  const close = (store: ResearchActionStore) => { store.close(); opened.delete(store) }
  const store = open()
  const run = store.create(owner, runId, { questionSha256: 'question', sourcesSha256: 'public',
    modeSha256: 'mode', destinationSha256: 'original', plan: null })
  store.confirm(owner, runId, run.revision, run.bindingSha256)
  const request: ResearchActionRequest = { runId, actionId, stepId: 'plan' as ResearchStepId,
    revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256, driverId: 'fake' as ResearchDriverId,
    selection: { model: 'fake-model', mode: 'fake-mode', effort: { kind: 'required', value: 'high' }, tools: ['web'] },
    target: { workspace: 'fixture', page: 'original-page', conversation: null }, kind: 'gemini-plan-submit', preparedPromptId: null, input: 'all original bytes' }
  const qualification: ResearchDriverQualification = { status: 'available', requestSha256: researchActionFingerprint(request),
    target: request.target, selection: request.selection, effort: { kind: 'not_observed' },
    inputMaxBytes: 2048, evidence: 'fake explicit normal interface observation; effort control not exposed' }
  return { store, open, close, filename, request, qualification }
}

async function unknown(store: ResearchActionStore, request: ResearchActionRequest) {
  await expect(store.execute(owner, request, async () => { throw Error('fixture qualification transport threw') }))
    .rejects.toThrow('transport threw')
}

describe('durable actual Driver qualification', () => {
  it('does not fabricate qualification after a missing reply or replay it after reopening', async () => {
    const f = setup()
    await unknown(f.store, f.request)
    expect(f.store.readQualification(owner, runId, actionId)).toBeNull()
    f.close(f.store)
    const reopened = f.open()
    const replay = vi.fn(async () => { throw Error('must not replay') })
    expect((await reopened.execute(owner, f.request, replay)).state).toBe('unknown')
    expect(reopened.readQualification(owner, runId, actionId)).toBeNull()
    expect(replay).not.toHaveBeenCalled()
  })

  it('retains actual unobserved effort independently of requested high effort across restart', async () => {
    const f = setup()
    await unknown(f.store, f.request)
    const hash = researchActionFingerprint(f.request)
    const record = f.store.recordQualification(owner, runId, actionId, hash, f.qualification)
    expect(record.observation).toEqual(f.qualification)
    expect(record.recordedAt).toBe(new Date(record.recordedAt).toISOString())
    expect(f.store.recordQualification(owner, runId, actionId, hash, f.qualification)).toEqual(record)
    const second = f.open()
    expect(second.readQualification(owner, runId, actionId)).toEqual(record)
    f.close(second); f.close(f.store)
    expect(f.open().readQualification(owner, runId, actionId)).toEqual(record)
  })

  it('refuses another request, owner or changed observation without overwriting the first result', async () => {
    const f = setup()
    await unknown(f.store, f.request)
    const hash = researchActionFingerprint(f.request)
    const original = f.store.recordQualification(owner, runId, actionId, hash, f.qualification)
    expect(() => f.store.recordQualification(owner, runId, actionId, 'another-request', f.qualification)).toThrow('request conflicts')
    expect(() => f.store.recordQualification(owner, runId, actionId, hash, { status: 'unsupported', reason: 'different result' }))
      .toThrow('immutable qualification')
    expect(() => f.store.readQualification('other-owner' as ResearchOwnerId, runId, actionId)).toThrow('another owner')
    expect(f.store.readQualification(owner, runId, actionId)).toEqual(original)
  })

  it.each(['unsupported', 'not_observed'] as const)('retains explicit %s evidence without claiming a completed action', async (status) => {
    const f = setup()
    await unknown(f.store, f.request)
    const record = f.store.recordQualification(owner, runId, actionId, researchActionFingerprint(f.request),
      { status, reason: 'fake normal interface does not establish capability' })
    expect(record.observation).toEqual({ status, reason: 'fake normal interface does not establish capability' })
    expect(f.store.readAction(owner, runId, actionId).state).toBe('unknown')
  })

  it.each(['digest', 'json', 'request', 'timestamp'])('rejects damaged durable %s instead of filling requested fields', async (damage) => {
    const f = setup()
    await unknown(f.store, f.request)
    f.store.recordQualification(owner, runId, actionId, researchActionFingerprint(f.request), f.qualification)
    const db = new DatabaseSync(f.filename)
    if (damage === 'digest') db.prepare('UPDATE research_driver_qualifications SET sha256=?').run('bad')
    if (damage === 'json') db.prepare('UPDATE research_driver_qualifications SET qualification_json=?').run('{}')
    if (damage === 'request') db.prepare('UPDATE research_driver_qualifications SET request_sha256=?').run('other')
    if (damage === 'timestamp') db.prepare('UPDATE research_driver_qualifications SET recorded_at=?').run('invalid')
    db.close()
    expect(() => f.store.readQualification(owner, runId, actionId)).toThrow()
  })
})
