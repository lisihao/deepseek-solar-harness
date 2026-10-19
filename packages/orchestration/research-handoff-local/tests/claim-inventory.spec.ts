import type {
  ResearchDriverId,
  ResearchActionId,
  ResearchOwnerId,
  ResearchRunId,
  ResearchStepId,
  ResearchArtifactId,
  ResearchArtifactSnapshot,
  ResearchClaim,
  ResearchClaimId,
  ResearchClaimInventoryInput,
  ResearchJudgmentId,
} from '@deepseek-ai/dsh-research-handoff/api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchActionStore } from '../src/action-store.ts'
import { researchArtifactHash } from '../src/artifact.ts'
import { parseResearchClaimInventory } from '../src/claim-inventory.ts'

const owner = 'candidate-owner' as ResearchOwnerId
const attribution = { channel: 'imported' as const, ownerId: owner, hostPolicyVersion: 'fixture-host-v1' }
const other = 'another-owner' as ResearchOwnerId
const runId = 'candidate-run' as ResearchRunId
const claimA = 'claim-a' as ResearchClaimId
const claimB = 'claim-b' as ResearchClaimId
const questionSha256 = researchArtifactHash(new TextEncoder().encode('fixture research question'))

describe('versioned critical claim denominator and attributed judgments', () => {
  let directory: string
  let filename: string
  let store: ResearchActionStore
  let gemini: ResearchArtifactSnapshot
  let chatgpt: ResearchArtifactSnapshot
  const opened = new Set<ResearchActionStore>()
  const open = (): ResearchActionStore => { const item = new ResearchActionStore(filename); opened.add(item); return item }
  const input = (): ResearchClaimInventoryInput => ({
    expectedVersion: 0, questionSha256,
    materials: [gemini, chatgpt].map(x => ({ artifactId: x.artifactId, sha256: x.sha256 })),
    claims: [
      { id: claimA, text: 'question candidate', critical: true, origins: [{ kind: 'question', artifactId: null, sha256: questionSha256 }] },
      { id: claimB, text: 'first-stage candidate', critical: true,
        origins: [{ kind: 'gemini-report', artifactId: gemini.artifactId, sha256: gemini.sha256 }] },
    ],
    changes: [],
  })
  const confirm = (): ReturnType<ResearchActionStore['confirmClaimInventory']> => {
    const inventory = store.appendClaimInventory(owner, runId, input())
    return store.confirmClaimInventory(owner, runId, inventory.version, inventory.sha256)
  }
  const captureNext = (extent: 'complete' | 'partial' | 'unknown'): ResearchArtifactSnapshot => store.captureArtifact(owner, runId, {
    artifactId: 'gemini-v2' as ResearchArtifactId, actionId: gemini.actionId, role: 'gemini-report', expectedVersion: 1,
    source: { ...gemini.source, extent, endEvidence: extent === 'complete' ? 'fixture next report end' : null },
    bytes: new TextEncoder().encode('fixture changed report'),
  })

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-research-claims-'))
    filename = join(directory, 'research.sqlite')
    store = open()
    const run = store.create(owner, runId, {
      questionSha256, sourcesSha256: 'fixture sources', modeSha256: 'fixture mode', destinationSha256: 'fixture destination', plan: null,
    })
    store.confirm(owner, runId, run.revision, run.bindingSha256)
    for (const stage of ['gemini', 'chatgpt'] as const) {
      const actionId = `${stage}-action` as ResearchActionId
      await store.execute(owner, {
        runId, actionId, stepId: `${stage}-step` as ResearchStepId, revision: 1, bindingSha256: run.bindingSha256,
        binding: run.binding, driverId: 'fixture-driver' as ResearchDriverId,
        selection: { model: 'fixture-model', mode: 'fixture-mode', effort: { kind: 'not-requested' }, tools: [] },
        kind: stage === 'gemini' ? 'gemini-research-start' : 'chatgpt-submit', preparedPromptId: null, input: 'fixture full question and materials',
        target: { workspace: 'fixture', page: stage, conversation: `${stage}-conversation` },
      }, async () => ({ state: 'completed', receipt: 'fake transport completed; no actual website call',
        acceptedResource: { workspace: 'fixture', page: stage, conversation: stage+'-conversation', report: null,
          evidence: 'explicit fake stage acceptance; no website request' } }))
      const artifact = store.captureArtifact(owner, runId, {
        artifactId: `${stage}-v1` as ResearchArtifactId, actionId, role: `${stage}-report`, expectedVersion: 0,
        source: { page: stage, conversation: `${stage}-conversation`, method: 'manual-import',
          capturedAt: '2026-10-17T17:00:00Z', extent: 'complete', endEvidence: 'fixture source end' },
        bytes: new TextEncoder().encode(`${stage} fixture original report and references`),
      })
      if (stage === 'gemini') gemini = artifact
      else chatgpt = artifact
    }
  })
  afterEach(() => {
    for (const item of opened) item.close()
    opened.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('requires a separate exact confirmation and retains candidates and provenance across restart', () => {
    const first = store.appendClaimInventory(owner, runId, { ...input(), denominatorConfirmed: true, verificationComplete: true })
    expect(first.denominatorConfirmed).toBe(false)
    expect(first.input).not.toHaveProperty('denominatorConfirmed')
    const confirmed = store.confirmClaimInventory(owner, runId, 1, first.sha256)
    expect(confirmed.denominatorConfirmed).toBe(true)
    expect(confirmed).not.toHaveProperty('verificationComplete')
    expect(confirmed).not.toHaveProperty('verifiedCoverage')
    store.close(); opened.delete(store)
    store = open()
    expect(store.readClaimInventory(owner, runId, 1)).toEqual(confirmed)
  })

  it('refuses silently removing a difficult critical candidate and leaves the original version intact', () => {
    const first = confirm()
    expect(() => store.appendClaimInventory(owner, runId, { ...input(), expectedVersion: 1, claims: input().claims.slice(1) }))
      .toThrow('no derivation')
    expect(store.readClaimInventory(owner, runId, 1)).toEqual(first)
    expect(() => store.readClaimInventory(owner, runId, 2)).toThrow('not found')
  })

  it('retains split, merge and downgrade parent identities and reasons in immutable versions', () => {
    const first = confirm()
    const a = input().claims[0]!
    const b = input().claims[1]!
    const a1 = { ...a, id: 'claim-a1' as ResearchClaimId, text: 'split first candidate' }
    const a2 = { ...a, id: 'claim-a2' as ResearchClaimId, text: 'split second candidate' }
    const second = store.appendClaimInventory(owner, runId, {
      ...input(), expectedVersion: 1, claims: [a1, a2, b],
      changes: [{ kind: 'split', from: [claimA], to: [a1.id, a2.id], reason: 'separate two test propositions' }],
    })
    const merged = { ...a, id: 'merged-a' as ResearchClaimId, text: 'merged candidate with retained parents' }
    const third = store.appendClaimInventory(owner, runId, {
      ...input(), expectedVersion: 2, claims: [merged, b],
      changes: [{ kind: 'merge', from: [a1.id, a2.id], to: [merged.id], reason: 'same fixture proposition after inspection' }],
    })
    const fourth = store.appendClaimInventory(owner, runId, {
      ...input(), expectedVersion: 3, claims: [{ ...merged, critical: false }, b],
      changes: [{ kind: 'downgrade', from: [merged.id], to: [merged.id], reason: 'explicit fixture scope decision awaiting control review' }],
    })
    expect([second, third, fourth].every(x => !x.denominatorConfirmed)).toBe(true)
    expect(store.readClaimInventory(owner, runId, 1).input.claims).toEqual(first.input.claims)
    expect(store.readClaimInventory(owner, runId, 3).input.changes[0]?.from).toEqual([a1.id, a2.id])
    expect(() => store.confirmClaimInventory(owner, runId, 1, first.sha256)).toThrow('exact current')
  })

  it('records explicit removal but never inherits its prior denominator confirmation', () => {
    const first = confirm()
    const next = { ...input(), expectedVersion: 1, claims: input().claims.slice(1),
      changes: [{ kind: 'remove' as const, from: [claimA], to: [], reason: 'fixture scope removed by a proposed change' }] }
    expect(() => store.appendClaimInventory(owner, runId, { ...next, changes: [{ ...next.changes[0], reason: ' ' }] })).toThrow('empty')
    expect(store.appendClaimInventory(owner, runId, next).denominatorConfirmed).toBe(false)
    expect(store.readClaimInventory(owner, runId, 1).recordedConfirmation).toBe(true)
    expect(store.readClaimInventory(owner, runId, 1).isCurrent).toBe(false)
    expect(first.input.claims[0]?.critical).toBe(true)
  })

  it('requires lineage and the actual second-stage material digest for newly added facts', () => {
    confirm()
    const newClaim: ResearchClaim = { id: 'new-stage2-fact' as ResearchClaimId, text: 'fixture added external assertion', critical: true,
      origins: [{ kind: 'chatgpt-addition', artifactId: chatgpt.artifactId, sha256: chatgpt.sha256 }] }
    const next = { ...input(), expectedVersion: 1, claims: [...input().claims, newClaim] }
    expect(() => store.appendClaimInventory(owner, runId, next)).toThrow('no derivation')
    const changes = [{ kind: 'add' as const, from: [], to: [newClaim.id], reason: 'second-stage fixture adds a new external proposition' }]
    const wrong = { ...newClaim, origins: [{ ...newClaim.origins[0]!, sha256: '0'.repeat(64) }] }
    expect(() => store.appendClaimInventory(owner, runId, { ...next, changes, claims: [...input().claims, wrong] })).toThrow('owned bound material')
    expect(store.appendClaimInventory(owner, runId, { ...next, changes }).input.claims.at(-1)).toEqual(newClaim)
  })

  it('serializes two stores that both observed the same prior inventory version', () => {
    confirm()
    const second = open()
    const next = { ...input(), expectedVersion: 1 }
    expect(store.appendClaimInventory(owner, runId, next).version).toBe(2)
    expect(() => second.appendClaimInventory(owner, runId, next)).toThrow('version changed')
  })

  it('invalidates completeness when the question run revision changes', () => {
    const first = confirm()
    const run = store.inspect(owner, runId)
    store.revise(owner, runId, run.revision, { ...run.binding, questionSha256: 'f'.repeat(64) })
    expect(store.readClaimInventory(owner, runId, 1)).toMatchObject({
      recordedConfirmation: true, denominatorConfirmed: false, isCurrent: false,
    })
    expect(() => store.confirmClaimInventory(owner, runId, 1, first.sha256)).toThrow('exact current')
    expect(() => store.appendClaimInventory(owner, runId, { ...input(), expectedVersion: 1 })).toThrow('question binding changed')
  })

  it.each(['complete', 'partial', 'unknown'] as const)('new %s report bytes invalidate the old material denominator', (extent) => {
    const first = confirm()
    captureNext(extent)
    expect(store.readClaimInventory(owner, runId, 1)).toMatchObject({ recordedConfirmation: true, denominatorConfirmed: false })
    expect(() => store.confirmClaimInventory(owner, runId, 1, first.sha256)).toThrow('exact current')
  })

  it('requires complete captures of both latest stage reports before denominator confirmation', () => {
    const latest = captureNext('partial')
    const nextInput = { ...input(), materials: [...input().materials, { artifactId: latest.artifactId, sha256: latest.sha256 }] }
    const inventory = store.appendClaimInventory(owner, runId, nextInput)
    expect(() => store.confirmClaimInventory(owner, runId, 1, inventory.sha256)).toThrow('exact current')
  })

  it('preserves unverifiable and supported model judgments as attributed data, never source-read proof', () => {
    const inventory = store.appendClaimInventory(owner, runId, input())
    const value = { judgmentId: 'judgment-a' as ResearchJudgmentId, inventoryVersion: 1, claimId: claimA,
      by: 'model' as const, status: 'unverifiable' as const, rationale: 'fixture has no independently reopened source',
      materialArtifactIds: [gemini.artifactId], verificationComplete: true, verifiedCoverage: 1 }
    const first = store.appendClaimJudgment(owner, runId, value, attribution)
    expect(first).not.toHaveProperty('verificationComplete')
    expect(first).not.toHaveProperty('verifiedCoverage')
    expect(store.appendClaimJudgment(owner, runId, value, attribution)).toEqual(first)
    expect(() => store.appendClaimJudgment(owner, runId, { ...value, status: 'supported' }, attribution)).toThrow('immutable')
    const next = store.appendClaimJudgment(owner, runId, { ...value, judgmentId: 'judgment-b', status: 'supported',
      rationale: 'fixture model reconsidered' }, attribution)
    const rows = store.readClaimJudgments(owner, runId, 1, 0, 10)
    expect(rows.map(x => x.status)).toEqual(['unverifiable', 'supported'])
    expect(store.readClaimJudgments(owner, runId, 1, first.seq, 1)).toEqual([next])
    expect(store.readClaimInventory(owner, runId, inventory.version).denominatorConfirmed).toBe(false)
    store.close(); opened.delete(store); store = open()
    expect(store.readClaimJudgments(owner, runId, 1, 0, 10)).toEqual(rows)
  })

  it('refuses changing stored channel attribution or supplying another attribution owner', () => {
    store.appendClaimInventory(owner, runId, input())
    const value = { judgmentId: 'attributed', inventoryVersion: 1, claimId: claimA, by: 'human',
      status: 'supported', rationale: 'declared content', materialArtifactIds: [] }
    const original = store.appendClaimJudgment(owner, runId, value, attribution)
    expect(() => store.appendClaimJudgment(owner, runId, value, { ...attribution, channel: 'human' })).toThrow('immutable')
    expect(() => store.appendClaimJudgment(owner, runId, value, { ...attribution, ownerId: other })).toThrow('owner conflicts')
    expect(store.readClaimJudgments(owner, runId, 1, 0, 10)).toEqual([original])
  })

  it.each(['digest', 'json', 'owner'])('rejects damaged durable judgment attribution %s', (damage) => {
    store.appendClaimInventory(owner, runId, input())
    store.appendClaimJudgment(owner, runId, { judgmentId: 'attributed', inventoryVersion: 1, claimId: claimA,
      by: 'human', status: 'supported', rationale: 'declared content', materialArtifactIds: [] }, attribution)
    const db = new DatabaseSync(filename)
    if (damage === 'digest') db.prepare('UPDATE research_claim_judgments SET attribution_sha256=?').run('wrong')
    else {
      const raw = JSON.stringify(damage === 'json' ? {} : { ...attribution, ownerId: other })
      db.prepare('UPDATE research_claim_judgments SET attribution_json=?,attribution_sha256=?')
        .run(raw, researchArtifactHash(new TextEncoder().encode(raw)))
    }
    db.close()
    expect(() => store.readClaimJudgments(owner, runId, 1, 0, 10)).toThrow()
  })

  it('rejects a judgment for a claim outside its pinned inventory', () => {
    confirm()
    expect(() => store.appendClaimJudgment(owner, runId, {
      judgmentId: 'wrong-claim', inventoryVersion: 1, claimId: 'not-in-inventory', by: 'model', status: 'supported',
      rationale: 'unbound fixture', materialArtifactIds: [],
    }, attribution)).toThrow('absent from its inventory')
  })

  it('rejects cross-owner reads, appends, confirmation and judgments despite known ids and hashes', () => {
    const inventory = confirm()
    expect(() => store.readClaimInventory(other, runId, 1)).toThrow('another owner')
    expect(() => store.appendClaimInventory(other, runId, { ...input(), expectedVersion: 1 })).toThrow('another owner')
    expect(() => store.confirmClaimInventory(other, runId, 1, inventory.sha256)).toThrow('another owner')
    expect(() => store.readClaimJudgments(other, runId, 1, 0, 10)).toThrow('another owner')
  })

  it('refuses corrupted inventory JSON without manufacturing a current denominator', () => {
    confirm()
    const db = new DatabaseSync(filename)
    db.prepare('UPDATE research_claim_inventories SET inventory_json=?').run('{}')
    db.close()
    expect(() => store.readClaimInventory(owner, runId, 1)).toThrow('invalid durable claim inventory')
  })

  it('rejects duplicate candidate ids and malformed operation cardinality at the input boundary', () => {
    expect(() => parseResearchClaimInventory({ ...input(), claims: [...input().claims, input().claims[0]] })).toThrow('duplicate claim')
    confirm()
    expect(() => store.appendClaimInventory(owner, runId, { ...input(), expectedVersion: 1,
      changes: [{ kind: 'split', from: [claimA], to: [claimA], reason: 'not actually a split' }] })).toThrow('cardinality')
  })
})
