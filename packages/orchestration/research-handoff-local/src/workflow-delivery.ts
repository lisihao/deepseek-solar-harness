/** Standard stage delivery and exact mismatch treatments in the original SQLite owner. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchOwnerId, type ResearchRunId, type ResearchActionId,
  type ResearchActionRequest, type ResearchActionSnapshot, type ResearchWorkflowDefinition,
  type ResearchWorkflowStage, type ResearchWorkflowOutput, type ResearchWorkflowMaterial,
  type ResearchWorkflowPrerequisites, type ResearchWorkflowStageEvidence, type ResearchPreparedPrompt,
  type ResearchDeliveryRecord, type ResearchWorkflowDeliveryRef, type ResearchJudgmentAttribution,
  type ResearchWorkflowDeliveryDispositionInput, type ResearchWorkflowDeliveryDisposition,
  type ResearchWorkflowDeliveryDispositionId,
} from '@deepseek-ai/dsh-research-handoff/api'
import { researchArtifactText } from './artifact.ts'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const kinds = ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'] as const
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('workflow delivery object required', 'FORMAT')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.from(value).toString('utf8') !== value) {
    throw new ResearchActionError('invalid workflow delivery text', 'FORMAT')
  }
  return value
}
function ref(value: unknown): ResearchWorkflowDeliveryRef {
  const v = object(value)
  if (typeof v.seq !== 'number' || !Number.isSafeInteger(v.seq) || v.seq < 1) {
    throw new ResearchActionError('invalid delivery sequence', 'FORMAT')
  }
  return { seq: v.seq, sha256: text(v.sha256) }
}
const reference = (r: ResearchDeliveryRecord): ResearchWorkflowDeliveryRef => ({ seq: r.seq, sha256: r.sha256 })
const negatives = (rows: readonly ResearchDeliveryRecord[]): ResearchWorkflowDeliveryRef[] => rows.filter(x => x.contentStatus === 'mismatched').map(reference)
function input(value: unknown): ResearchWorkflowDeliveryDispositionInput {
  const v = object(value)
  if (!Array.isArray(v.negative) || v.negative.length === 0) throw new ResearchActionError('exact mismatches required', 'FORMAT')
  const negative = v.negative.map(ref)
  if (negative.some((x, i) => i > 0 && x.seq <= (negative[i - 1]?.seq ?? 0))) {
    throw new ResearchActionError('mismatch sequence must be complete and ordered', 'FORMAT')
  }
  return { dispositionId: text(v.dispositionId) as ResearchWorkflowDeliveryDispositionId,
    actionId: text(v.actionId) as ResearchActionId,
    expectedPreviousId: v.expectedPreviousId === null ? null : text(v.expectedPreviousId) as ResearchWorkflowDeliveryDispositionId,
    negative, correction: ref(v.correction), reason: text(v.reason) }
}

interface DeliveryInputs {
  definition(owner: ResearchOwnerId, run: ResearchRunId): ResearchWorkflowDefinition | null
  action(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchActionId): ResearchActionSnapshot
  prepared(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchPreparedPrompt['inputId']): ResearchPreparedPrompt
  history(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchActionId): ResearchDeliveryRecord[]
  outputs(owner: ResearchOwnerId, run: ResearchRunId, workflow: ResearchWorkflowDefinition['input']['workflowId']): ResearchWorkflowOutput[]
  requestJson(request: ResearchActionRequest): string
}

/** No action admission state is added; all gates derive from original immutable actions and observations. */
export class ResearchWorkflowDeliveries {
  /**
   * @param db - Original action database.
   * @param inputs - Owner-authorized original records.
   */
  constructor(private readonly db: DatabaseSync, private readonly inputs: DeliveryInputs) {}

  private definition(owner: ResearchOwnerId, run: ResearchRunId): ResearchWorkflowDefinition {
    const d = this.inputs.definition(owner, run)
    if (d === null) throw new ResearchActionError('canonical workflow required', 'NOT_FOUND')
    return d
  }

  private material(owner: ResearchOwnerId, d: ResearchWorkflowDefinition, role: 'gemini-plan' | 'gemini-report' | 'chatgpt-report',
    saved?: unknown): ResearchWorkflowMaterial | null {
    const outputs = this.inputs.outputs(owner, d.runId, d.input.workflowId)
    let id: unknown
    if (saved !== undefined) {
      if (saved === null) return null
      id = object(object(saved).artifact).artifactId
    } else {
      id = this.db.prepare('SELECT artifact_id FROM research_artifacts WHERE run_id=? AND role=? ORDER BY version DESC LIMIT 1')
        .get(d.runId, role)?.artifact_id
    }
    const output = outputs.find(x => x.artifact.artifactId === id && x.artifact.role === role)
    if (output === undefined || output.artifact.source.extent !== 'complete') return null
    const { bytes, ...artifact } = output.artifact
    const result: ResearchWorkflowMaterial = { observationId: output.observationId, resource: output.resource,
      artifact: { ...artifact, text: researchArtifactText(bytes) } }
    if (saved !== undefined && !same(result, saved)) throw new ResearchActionError('historical workflow material differs', 'FORMAT')
    return result
  }

  private action(owner: ResearchOwnerId, d: ResearchWorkflowDefinition, kind: ResearchWorkflowStage['kind']): ResearchActionSnapshot | null {
    const stage = d.input.stages.find(x => x.kind === kind)
    if (stage === undefined) throw new ResearchActionError('canonical stage missing', 'FORMAT')
    try { return this.inputs.action(owner, d.runId, stage.actionId) }
    catch (error) { if (error instanceof ResearchActionError && error.code === 'NOT_FOUND') return null; throw error }
  }

  private linked(d: ResearchWorkflowDefinition, a: ResearchActionSnapshot, p: ResearchPreparedPrompt | null,
    material: ResearchWorkflowMaterial | null, upload: ResearchActionSnapshot | null): boolean {
    const r = a.request, stage = d.input.stages.find(x => x.kind === r.kind)
    const platform = r.kind.startsWith('gemini-') ? d.input.gemini : d.input.chatgpt
    if (stage?.actionId !== r.actionId || stage.stepId !== r.stepId || stage.preparedPromptId !== r.preparedPromptId
      || r.runId !== d.runId || r.binding.questionSha256 !== hash(d.input.question)
      || r.binding.sourcesSha256 !== d.input.sourcesSha256 || r.driverId !== platform.driverId
      || r.binding.destinationSha256 !== platform.destinationSha256 || r.target.workspace !== platform.target.workspace
      || this.inputs.requestJson(r) !== this.inputs.requestJson({ ...r, selection: platform.selection })) return false
    const target = r.kind === 'gemini-research-start' || r.kind === 'chatgpt-submit' ? upload?.acceptedResource : platform.target
    if (target == null || (r.kind === 'gemini-research-start' || r.kind === 'chatgpt-submit') && target.conversation === null
      || r.target.workspace !== target.workspace || r.target.page !== target.page
      || r.target.conversation !== target.conversation) return false
    if (r.kind === 'gemini-plan-submit' || r.kind === 'chatgpt-submit') {
      if (p === null || p.inputId !== r.preparedPromptId || p.revision !== r.revision || p.renderedText !== r.input
        || p.questionSha256 !== r.binding.questionSha256
        || p.template.id !== (r.kind === 'gemini-plan-submit' ? 'gemini-deep-research' : 'chatgpt-verify-synthesize')
        || p.template.version !== (r.kind === 'gemini-plan-submit' ? d.input.templateVersions.gemini : d.input.templateVersions.chatgpt)) return false
      const slots = r.kind === 'gemini-plan-submit' ? d.input.values.gemini : d.input.values.chatgpt
      const parts = Object.values(p.values).flat().filter(x => x.kind === 'artifact')
      for (const [name, values] of Object.entries(p.values)) {
        if (values.some(x => x.kind === 'artifact')
          ? r.kind !== 'chatgpt-submit' || name !== 'handoff_manifest_and_artifacts' || values.length !== 1
          : !same(values.map(x => x.text), slots[name])) return false
      }
      if (r.kind === 'gemini-plan-submit') return parts.length === 0 && material === null
      const part = parts[0], m = material?.artifact, target = upload?.acceptedResource
      return parts.length === 1 && part !== undefined && m !== undefined && part.artifactId === m.artifactId
        && part.version === m.version && part.sha256 === m.sha256 && part.text === m.text
        && target !== undefined && target !== null && target.conversation !== null
        && r.target.workspace === target.workspace && r.target.page === target.page && r.target.conversation === target.conversation
    }
    if (p !== null || material === null || r.input !== material.artifact.text) return false
    return r.kind !== 'gemini-research-start' || r.binding.plan?.version === material.artifact.version
      && r.binding.plan.sha256 === material.artifact.sha256
  }

  private validTreatment(record: ResearchWorkflowDeliveryDisposition, a: ResearchActionSnapshot,
    material: ResearchWorkflowMaterial | null, history: readonly ResearchDeliveryRecord[]): boolean {
    if (!same(record.action, a) || !same(record.material, material) || !same(record.input.negative, negatives(history))) return false
    const correction = history.find(x => same(reference(x), record.input.correction))
    return correction !== undefined && correction.contentStatus === 'matched'
      && record.input.negative.every(x => x.seq < correction.seq)
      && history.every(x => x.observation.externalId === correction.observation.externalId)
  }

  private stage(owner: ResearchOwnerId, d: ResearchWorkflowDefinition, kind: ResearchWorkflowStage['kind'], saved?: unknown): ResearchWorkflowStageEvidence {
    const old = saved === undefined ? undefined : object(saved), a = this.action(owner, d, kind)
    const role = kind === 'gemini-research-start' ? 'gemini-plan'
      : kind === 'chatgpt-upload' || kind === 'chatgpt-submit' ? 'gemini-report' : null
    const material = role === null ? null : this.material(owner, d, role, old?.material)
    const outputRole = kind === 'gemini-plan-submit' ? 'gemini-plan' : kind === 'gemini-research-start' ? 'gemini-report'
      : kind === 'chatgpt-submit' ? 'chatgpt-report' : null
    const output = outputRole === null ? null : this.material(owner, d, outputRole, old?.output)
    let history = a === null || kind === 'gemini-research-start' ? [] : this.inputs.history(owner, d.runId, a.request.actionId)
    if (old !== undefined) {
      if (!Array.isArray(old.history)) throw new ResearchActionError('historical delivery list required', 'FORMAT')
      const rows: readonly unknown[] = old.history
      const last = rows.at(-1), through = last === undefined ? 0 : ref(last).seq
      history = history.filter(x => x.seq <= through)
      if (!same(history, old.history)) throw new ResearchActionError('historical delivery list differs', 'FORMAT')
    }
    const p = a?.request.preparedPromptId == null ? null : this.inputs.prepared(owner, d.runId, a.request.preparedPromptId)
    const upload = kind === 'chatgpt-submit' ? this.action(owner, d, 'chatgpt-upload')
      : kind === 'gemini-research-start' ? this.action(owner, d, 'gemini-plan-submit') : null
    let disposition: ResearchWorkflowDeliveryDisposition | null = null
    if (a !== null && kind !== 'gemini-research-start') {
      const row = old === undefined ? this.db.prepare('SELECT disposition_id FROM research_workflow_delivery_dispositions WHERE run_id=? AND action_id=? ORDER BY seq DESC LIMIT 1')
        .get(d.runId, a.request.actionId) : null
      const id = old === undefined ? row?.disposition_id
        : old.disposition === null ? undefined : object(object(old.disposition).input).dispositionId
      if (id !== undefined) disposition = this.readTreatment(owner, d.runId, text(id) as ResearchWorkflowDeliveryDispositionId)
    }
    const blockers: string[] = []
    if (a === null) blockers.push('action-missing')
    else {
      if (a.state !== 'completed' || a.acceptedResource === null) blockers.push('action-incomplete')
      if (!this.linked(d, a, p, material, upload)) blockers.push('original-input-unlinked')
    }
    if (outputRole !== null && output === null) blockers.push('complete-canonical-output-missing')
    const mismatch = negatives(history)
    const treatment = a !== null && disposition !== null && this.validTreatment(disposition, a, material, history)
    const deliveryVerified = kind === 'gemini-research-start' || history.some(x => x.contentStatus === 'matched')
      && (mismatch.length === 0 || treatment)
    if (!deliveryVerified) blockers.push(mismatch.length > 0 ? 'mismatch-unresolved' : 'complete-delivery-missing')
    const result = { kind, action: a, preparedPrompt: p, material, output, history, disposition, deliveryVerified, blockers }
    if (old !== undefined && !same(result, saved)) throw new ResearchActionError('historical workflow stage differs', 'FORMAT')
    return result
  }

  /**
   * Read the original stage delivery evidence and its current blockers.
   * @param owner - Live owner.
   * @param run - Canonical run.
   * @param kind - Actual stage to inspect.
   * @returns Full original delivery history and independent stage blockers from one SQLite snapshot.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, kind: ResearchWorkflowStage['kind']): ResearchWorkflowStageEvidence {
    this.db.exec('BEGIN')
    try {
      const result = this.readInTransaction(owner, run, kind)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read original stage evidence without starting a nested transaction.
   * @param owner - Current owner.
   * @param run - Canonical run.
   * @param kind - Original stage.
   * @returns Original stage evidence within the caller-owned read transaction; no nested BEGIN.
   */
  readInTransaction(owner: ResearchOwnerId, run: ResearchRunId, kind: ResearchWorkflowStage['kind']): ResearchWorkflowStageEvidence {
    return this.stage(owner, this.definition(owner, run), kind)
  }

  /**
   * Runs inside the preview owner's transaction; it never requires the proposed stage's own future delivery.
   * @param owner - Live owner.
   * @param run - Canonical run.
   * @param kind - Proposed next stage.
   * @param saved - Optional durable historical basis to reconstruct against original immutable records.
   * @returns Previous-stage facts and a key that ignores additional positive read-backs while retaining all mismatches.
   */
  prerequisites(owner: ResearchOwnerId, run: ResearchRunId, kind: ResearchWorkflowStage['kind'], saved?: unknown): ResearchWorkflowPrerequisites {
    const d = this.definition(owner, run), index = kinds.indexOf(kind)
    if (index < 0) throw new ResearchActionError('unknown workflow stage', 'FORMAT')
    const old = saved === undefined ? undefined : object(saved)
    if (old !== undefined && (!Array.isArray(old.stages) || old.stages.length !== index)) {
      throw new ResearchActionError('historical prerequisite stages differ', 'FORMAT')
    }
    const selected = old?.stages as readonly unknown[] | undefined
    const stages = kinds.slice(0, index).map((k, i) => this.stage(owner, d, k, selected?.[i]))
    const key = hash(JSON.stringify(stages.map(s => ({ kind: s.kind, action: s.action,
      material: s.material, output: s.output, negative: negatives(s.history),
      match: s.disposition === null ? s.history.find(x => x.contentStatus === 'matched') ?? null
        : s.history.find(x => same(reference(x), s.disposition?.input.correction)) ?? null,
      dispositionSha256: s.disposition?.sha256 ?? null, blockers: s.blockers }))))
    const result = { workflowId: d.input.workflowId, definitionSha256: d.sha256, kind, stages,
      ready: stages.every(s => s.blockers.length === 0), key }
    if (old !== undefined && !same(result, saved)) throw new ResearchActionError('durable prerequisite basis differs', 'FORMAT')
    return result
  }

  /**
   * Append an exact human mismatch treatment with compare-and-swap.
   * @param owner - Live owner.
   * @param run - Owned run.
   * @param value - Exact original negatives and later correction.
   * @param attribution - Actual trusted human entry, never imported authority.
   * @returns Immutable append-only treatment.
   */
  append(owner: ResearchOwnerId, run: ResearchRunId, value: unknown,
    attribution: ResearchJudgmentAttribution): ResearchWorkflowDeliveryDisposition {
    const fixed = input(value), actual = parseResearchJudgmentAttribution(attribution)
    if (actual.channel !== 'human' || actual.ownerId !== owner) throw new ResearchActionError('actual human delivery treatment required', 'CONFIRMATION')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const d = this.definition(owner, run)
      const original = this.db.prepare('SELECT disposition_id FROM research_workflow_delivery_dispositions WHERE run_id=? AND disposition_id=?')
        .get(run, fixed.dispositionId)
      if (original !== undefined) {
        const retained = this.readTreatment(owner, run, fixed.dispositionId)
        if (!same(retained.input, fixed)) throw new ResearchActionError('immutable delivery treatment conflicts', 'CONFLICT')
        this.db.exec('COMMIT')
        return retained
      }
      const kind = d.input.stages.find(s => s.actionId === fixed.actionId)?.kind
      if (kind === undefined || kind === 'gemini-research-start') throw new ResearchActionError('original data delivery required', 'CONFLICT')
      const stage = this.stage(owner, d, kind), action = stage.action
      if (action === null || action.state !== 'completed' || action.acceptedResource === null
        || stage.blockers.some(x => x !== 'mismatch-unresolved' && x !== 'complete-canonical-output-missing')) {
        throw new ResearchActionError('completed linked original delivery required', 'CONFLICT')
      }
      if ((stage.disposition?.input.dispositionId ?? null) !== fixed.expectedPreviousId) {
        throw new ResearchActionError('delivery treatment compare-and-swap differs', 'CONFLICT')
      }
      const record = { input: fixed, workflowId: d.input.workflowId, definitionSha256: d.sha256, action,
        material: stage.material, history: stage.history, attribution: actual, recordedAt: new Date().toISOString() }
      if (!this.validTreatment({ ...record, sha256: '' }, action, stage.material, stage.history)) {
        throw new ResearchActionError('all exact mismatches and later same-item full match required', 'CONFLICT')
      }
      const raw = JSON.stringify(record)
      this.db.prepare('INSERT INTO research_workflow_delivery_dispositions(run_id,action_id,disposition_id,input_json,sha256) VALUES(?,?,?,?,?)')
        .run(run, action.request.actionId, fixed.dispositionId, raw, hash(raw))
      const result = this.readTreatment(owner, run, fixed.dispositionId)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read the immutable treatment and validate its original action ownership.
   * @param owner - Current owner.
   * @param run - Original run.
   * @param id - Immutable treatment identity.
   * @returns Complete original basis; later observations never backfill its history.
   */
  readTreatment(owner: ResearchOwnerId, run: ResearchRunId,
    id: ResearchWorkflowDeliveryDispositionId): ResearchWorkflowDeliveryDisposition {
    const d = this.definition(owner, run), row = this.db.prepare('SELECT * FROM research_workflow_delivery_dispositions WHERE run_id=? AND disposition_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('delivery treatment not found', 'NOT_FOUND')
    const raw = text(row.input_json), v = object(JSON.parse(raw) as unknown), fixed = input(v.input)
    const action = this.inputs.action(owner, run, fixed.actionId), kind = action.request.kind
    if (!Array.isArray(v.history) || v.history.length === 0 || kind === 'gemini-research-start'
      || !d.input.stages.some(x => x.kind === kind && x.actionId === fixed.actionId)) {
      throw new ResearchActionError('invalid historical delivery treatment stage', 'FORMAT')
    }
    const through = ref(v.history.at(-1)).seq
    const history = this.inputs.history(owner, run, fixed.actionId).filter(x => x.seq <= through)
    const material = kind === 'gemini-plan-submit' ? null : this.material(owner, d, 'gemini-report', v.material)
    const record = { input: fixed, workflowId: d.input.workflowId, definitionSha256: d.sha256, action, material, history,
      attribution: parseResearchJudgmentAttribution(v.attribution), recordedAt: text(v.recordedAt) }
    const previous = this.db.prepare('SELECT disposition_id FROM research_workflow_delivery_dispositions WHERE run_id=? AND action_id=? AND seq<? ORDER BY seq DESC LIMIT 1')
      .get(run, fixed.actionId, row.seq ?? null)
    const result = { ...record, sha256: hash(raw) }
    if ((previous?.disposition_id ?? null) !== fixed.expectedPreviousId
      || row.action_id !== fixed.actionId || fixed.dispositionId !== id || row.sha256 !== hash(raw) || !same(record, v)
      || action.state !== 'completed' || record.attribution.channel !== 'human' || record.attribution.ownerId !== owner
      || !Number.isFinite(Date.parse(record.recordedAt)) || !this.validTreatment(result, action, material, history)) {
      throw new ResearchActionError('invalid durable delivery treatment', 'FORMAT')
    }
    return result
  }
}
