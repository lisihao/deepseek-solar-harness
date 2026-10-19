import type {
  ResearchDriverId,
  ResearchActionId,
  ResearchOwnerId,
  ResearchRunId,
  ResearchStepId,
  ResearchArtifactId,
  ResearchArtifactInput,
  ResearchTextHandoff,
} from '@deepseek-ai/dsh-research-handoff/api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchActionStore } from '../src/action-store.ts'
import { researchArtifactHash, researchArtifactText, restoreResearchHandoff, splitResearchArtifact } from '../src/artifact.ts'

const owner = 'research-owner' as ResearchOwnerId
const other = 'other-owner' as ResearchOwnerId
const runId = 'research-run' as ResearchRunId
const actionId = 'gemini-start-action' as ResearchActionId
const artifactId = 'gemini-report-v1' as ResearchArtifactId
const input = (): ResearchArtifactInput => ({
  artifactId, actionId, role: 'gemini-report', expectedVersion: 0,
  source: {
    page: 'original-page', conversation: 'original-conversation', method: 'dom-text',
    capturedAt: '2026-10-17T16:50:00Z', extent: 'complete', endEvidence: 'observed report end and export boundary',
  },
  bytes: new TextEncoder().encode('\uFEFF完整研究报告\r\n𐐀😀é结尾\n'),
})

describe('owner-scoped immutable research artifacts and complete local handoff', () => {
  let directory: string
  let filename: string
  let store: ResearchActionStore
  const opened = new Set<ResearchActionStore>()
  const open = (): ResearchActionStore => { const item = new ResearchActionStore(filename); opened.add(item); return item }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-research-artifact-'))
    filename = join(directory, 'research.sqlite')
    store = open()
    const run = store.create(owner, runId, {
      questionSha256: 'question', sourcesSha256: 'sources', modeSha256: 'observed mode', destinationSha256: 'destination', plan: null,
    })
    store.confirm(owner, runId, run.revision, run.bindingSha256)
    await store.execute(owner, {
      runId, actionId, stepId: 'gemini-research' as ResearchStepId, revision: run.revision, bindingSha256: run.bindingSha256,
      binding: run.binding, driverId: 'fixture-driver' as ResearchDriverId,
      selection: { model: 'fixture-model', mode: 'fixture-mode', effort: { kind: 'not-requested' }, tools: [] },
      kind: 'gemini-research-start', target: { workspace: 'research', page: 'original-page', conversation: 'original-conversation' },
      preparedPromptId: null, input: 'confirmed plan and full original question',
    }, async () => ({ state: 'accepted', receipt: 'original research accepted; not yet observed finished',
      acceptedResource: { workspace: 'research', page: 'original-page', conversation: 'original-conversation', report: null,
        evidence: 'explicit fake original research acceptance; no website request' } }))
  })
  afterEach(() => {
    for (const item of opened) item.close()
    opened.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('retains all raw bytes including BOM, newlines, final text, source and action relation across restart', () => {
    const original = input()
    const artifact = store.captureArtifact(owner, runId, original)
    original.bytes.fill(0)
    const expected = input().bytes
    expect(artifact.bytes).toEqual(expected)
    store.close(); opened.delete(store)
    store = open()
    const recovered = store.readArtifact(owner, runId, artifactId)
    expect(recovered).toEqual(artifact)
    expect(researchArtifactText(recovered.bytes)).toBe('\uFEFF完整研究报告\r\n𐐀😀é结尾\n')
    expect(recovered.requestSha256).toBe(store.readAction(owner, runId, actionId).inputSha256)
  })

  it('does not infer process completion from a complete capture', () => {
    expect(store.captureArtifact(owner, runId, input()).source.extent).toBe('complete')
    expect(store.readAction(owner, runId, actionId).state).toBe('accepted')
  })

  it.each(['partial', 'unknown'] as const)('preserves %s extent instead of upgrading it', (extent) => {
    const original = input()
    expect(store.captureArtifact(owner, runId, { ...original, source: { ...original.source, extent, endEvidence: null } })
      .source).toMatchObject({ extent, endEvidence: null })
  })

  it('refuses complete capture without report-end evidence', () => {
    const original = input()
    expect(() => store.captureArtifact(owner, runId, { ...original, source: { ...original.source, endEvidence: null } }))
      .toThrow('missing report-end evidence')
    expect(() => store.readArtifact(owner, runId, artifactId)).toThrow('not found')
  })

  it('appends new versions while refusing concurrent stale role versions', () => {
    const first = store.captureArtifact(owner, runId, input())
    const secondStore = open()
    const next = { ...input(), artifactId: 'gemini-report-v2' as ResearchArtifactId }
    expect(() => secondStore.captureArtifact(owner, runId, next)).toThrow('version changed')
    const second = secondStore.captureArtifact(owner, runId, { ...next, expectedVersion: 1 })
    expect(second.version).toBe(2)
    expect(store.readArtifact(owner, runId, artifactId)).toEqual(first)
  })

  it('accepts an identical original capture id but never replaces its bytes or provenance', () => {
    const first = store.captureArtifact(owner, runId, input())
    expect(store.captureArtifact(owner, runId, input())).toEqual(first)
    expect(() => store.captureArtifact(owner, runId, { ...input(), bytes: new TextEncoder().encode('replacement') })).toThrow('immutable')
    const original = input()
    expect(() => store.captureArtifact(owner, runId, { ...original, source: { ...original.source, method: 'manual-import' } })).toThrow('immutable')
    expect(store.readArtifact(owner, runId, artifactId)).toEqual(first)
  })

  it.each([{ page: 'another-page' }, { conversation: 'another-conversation' }])('refuses unrelated capture targets: %j', (change) => {
    const original = input()
    expect(() => store.captureArtifact(owner, runId, { ...original, source: { ...original.source, ...change } })).toThrow('original action target')
  })

  it('does not grant artifact access to another owner who knows its id and digest', () => {
    const artifact = store.captureArtifact(owner, runId, input())
    expect(artifact.sha256).toBe(researchArtifactHash(input().bytes))
    expect(() => store.readArtifact(other, runId, artifactId)).toThrow('another owner')
    expect(() => store.captureArtifact(other, runId, input())).toThrow('another owner')
  })

  it('rejects malformed UTF-8 before storing replacement characters', () => {
    expect(() => store.captureArtifact(owner, runId, { ...input(), bytes: new Uint8Array([0xf0, 0x80, 0x80]) })).toThrow()
    expect(() => store.readArtifact(owner, runId, artifactId)).toThrow('not found')
  })

  it('rejects corrupted durable bytes rather than returning a successful capture', () => {
    store.captureArtifact(owner, runId, input())
    const db = new DatabaseSync(filename)
    db.prepare('UPDATE research_artifacts SET bytes=?').run(new Uint8Array([65]))
    db.close()
    expect(() => store.readArtifact(owner, runId, artifactId)).toThrow('invalid durable research artifact')
  })

  it.each([4, 7, 64])('round-trips all multibyte text with an explicit %i-byte segment budget', (budget) => {
    const original = input()
    const bytes = new TextEncoder().encode(researchArtifactText(original.bytes).repeat(1000))
    const artifact = store.captureArtifact(owner, runId, { ...original, bytes })
    const handoff = splitResearchArtifact(artifact, budget)
    expect(handoff.chunks.every(chunk => new TextEncoder().encode(chunk.text).length <= budget)).toBe(true)
    expect(restoreResearchHandoff(JSON.parse(JSON.stringify(handoff)) as unknown)).toEqual(bytes)
    expect(handoff.totalBytes).toBe(bytes.length)
    expect(handoff.chunks.at(-1)?.text).toContain('\n')
  })

  it('retains an empty artifact as one explicitly empty segment', () => {
    const artifact = store.captureArtifact(owner, runId, { ...input(), bytes: new Uint8Array() })
    const handoff = splitResearchArtifact(artifact, 4)
    expect(handoff.chunkCount).toBe(1)
    expect(handoff.chunks[0]).toMatchObject({ index: 0, byteStart: 0, byteEnd: 0, text: '' })
    expect(restoreResearchHandoff(handoff)).toEqual(new Uint8Array())
  })

  it.each([
    ['missing', (x: ResearchTextHandoff) => ({ ...x, chunks: x.chunks.slice(1) })],
    ['reordered', (x: ResearchTextHandoff) => ({ ...x, chunks: [...x.chunks].reverse() })],
    ['duplicate', (x: ResearchTextHandoff) => ({ ...x, chunks: [x.chunks[0], ...x.chunks.slice(0, -1)] })],
    ['content changed', (x: ResearchTextHandoff) => ({ ...x, chunks: [{ ...x.chunks[0], text: 'lost source' }, ...x.chunks.slice(1)] })],
    ['range changed', (x: ResearchTextHandoff) => ({ ...x, chunks: [{ ...x.chunks[0], byteEnd: 999 }, ...x.chunks.slice(1)] })],
    ['full digest changed', (x: ResearchTextHandoff) => ({ ...x, sha256: '0'.repeat(64) })],
  ])('rejects %s imported segments', (_name, change) => {
    const handoff = splitResearchArtifact(store.captureArtifact(owner, runId, input()), 7)
    expect(() => restoreResearchHandoff(change(handoff))).toThrow()
  })

  it('rejects a smaller declared byte count and invalid segment budget', () => {
    const artifact = store.captureArtifact(owner, runId, input())
    expect(() => splitResearchArtifact(artifact, 3)).toThrow('at least four')
    const handoff = splitResearchArtifact(artifact, 7)
    expect(() => restoreResearchHandoff({ ...handoff, totalBytes: 1 })).toThrow('byte count')
  })

  it('rejects an imported unpaired surrogate even if its replacement-byte digest matches', () => {
    const text = '\uD800'
    const replacement = new TextEncoder().encode(text)
    expect(() => restoreResearchHandoff({
      format: 'research-text-handoff/v1', artifactId, artifactVersion: 1,
      sha256: researchArtifactHash(replacement), totalBytes: replacement.length, chunkCount: 1,
      chunks: [{ index: 0, byteStart: 0, byteEnd: replacement.length, text, sha256: researchArtifactHash(replacement) }],
    })).toThrow('chunk bytes changed')
  })

  it.each([1, 2, 3, 4, 5, 6])('refuses prior private schema %i without silently migrating it', (version) => {
    const prior = join(directory, 'prior.sqlite')
    const db = new DatabaseSync(prior)
    db.exec(`PRAGMA user_version=${version}`)
    db.close()
    expect(() => new ResearchActionStore(prior)).toThrow('unsupported research database version')
    const check = new DatabaseSync(prior)
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(version)
    check.close()
  })
})
