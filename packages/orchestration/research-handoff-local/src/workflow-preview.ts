/** Immutable standard previews and separate confirmations in the original SQLite owner. */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { ResearchActionError, type ResearchOwnerId, type ResearchRunId, type ResearchActionRun,
  type ResearchActionRequest, type ResearchActionSnapshot, type ResearchWorkflowDefinition,
  type ResearchWorkflowPreviewInput, type ResearchWorkflowPreviewData, type ResearchWorkflowPreview,
  type ResearchWorkflowPreviewId, type ResearchArtifactSnapshot, type ResearchArtifactId,
  type ResearchPreparedPrompt, type ResearchPromptPreparation, type ResearchJudgmentAttribution, type ResearchWorkflowPrerequisites,
  type ResearchConfirmationBinding, type ResearchDriverId, type ResearchDriverSelection,
} from '@deepseek-ai/dsh-research-handoff/api'
import { researchArtifactText } from './artifact.ts'
import { parseResearchPreparedPrompt } from './prompt.ts'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('preview object required', 'FORMAT')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.from(value).toString('utf8') !== value) {
    throw new ResearchActionError('invalid preview text', 'FORMAT')
  }
  return value
}

interface PreviewInputs {
  modeFingerprint(driver: ResearchDriverId, selection: ResearchDriverSelection): string
  revise(owner: ResearchOwnerId, run: ResearchRunId, revision: number, binding: ResearchConfirmationBinding): ResearchActionRun
  prerequisites(owner: ResearchOwnerId, run: ResearchRunId, kind: ResearchActionRequest['kind'], saved?: unknown): ResearchWorkflowPrerequisites
  run(owner: ResearchOwnerId, run: ResearchRunId): ResearchActionRun
  definition(owner: ResearchOwnerId, run: ResearchRunId): ResearchWorkflowDefinition | null
  artifact(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchArtifactId): ResearchArtifactSnapshot
  action(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchActionRequest['actionId']): ResearchActionSnapshot
  parseRequest(value: unknown): ResearchActionRequest
  requestJson(value: ResearchActionRequest): string
  prompt(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchPromptPreparation, at: string): ResearchPreparedPrompt
  prepare(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchPromptPreparation): ResearchPreparedPrompt
  prepared(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchPreparedPrompt['inputId']): ResearchPreparedPrompt
}

/** Preview metadata never admits an external action or restores a callable human entry. */
export class ResearchWorkflowPreviews {
  /**
   * @param db - Original action database.
   * @param inputs - Owner-checked original records and caller-transaction prompt writer.
   */
  constructor(private readonly db: DatabaseSync, private readonly inputs: PreviewInputs) {}

  /**
   * Build a canonical preview from the original template and current materials.
   * @param owner - Live owner.
   * @param runId - Canonical run.
   * @param kind - Explicit fixed stage.
   * @param id - Explicit preview identity.
   * @returns Full standard preview; only a changed binding revises the run, and neither confirmation nor action admission occurs.
   */
  standard(owner: ResearchOwnerId, runId: ResearchRunId, kind: ResearchActionRequest['kind'], id: ResearchWorkflowPreviewId): ResearchWorkflowPreview {
    const definition = this.definition(owner, runId), d = definition.input
    const stage = d.stages.find(x => x.kind === kind)
    if (stage === undefined) throw new ResearchActionError('canonical stage missing', 'FORMAT')
    try {
      this.inputs.action(owner, runId, stage.actionId)
      throw new ResearchActionError('standard stage already started; observe the original action', 'CONFLICT')
    } catch (error) { if (!(error instanceof ResearchActionError) || error.code !== 'NOT_FOUND') throw error }
    const basis = this.inputs.prerequisites(owner, runId, kind)
    if (!basis.ready) throw new ResearchActionError('standard stage prerequisites are not ready', 'CONFIRMATION')
    const previous = basis.stages.at(-1)
    const material = kind === 'gemini-research-start' || kind === 'chatgpt-upload' ? previous?.output?.artifact
      : kind === 'chatgpt-submit' ? previous?.material?.artifact : undefined
    const platform = kind.startsWith('gemini-') ? d.gemini : d.chatgpt
    const original = kind === 'gemini-research-start' || kind === 'chatgpt-submit' ? previous?.action?.acceptedResource : platform.target
    if (original == null) throw new ResearchActionError('original stage target missing', 'CONFLICT')
    const target = { workspace: original.workspace, page: original.page, conversation: original.conversation }
    const plan = basis.stages[0]?.output?.artifact
    const binding = { questionSha256: hash(d.question), sourcesSha256: d.sourcesSha256,
      modeSha256: this.inputs.modeFingerprint(platform.driverId, platform.selection), destinationSha256: platform.destinationSha256,
      plan: plan === undefined ? null : { version: plan.version, sha256: plan.sha256 } }
    const current = this.inputs.run(owner, runId)
    const run = JSON.stringify(binding) === JSON.stringify(current.binding) ? current
      : this.inputs.revise(owner, runId, current.revision, binding)
    let prompt: ResearchPromptPreparation | null = null
    let rendered = material?.text ?? ''
    if (kind === 'gemini-plan-submit' || kind === 'chatgpt-submit') {
      const values: Record<string, ResearchPromptPreparation['values'][string]> = Object.fromEntries(
        Object.entries(kind === 'gemini-plan-submit' ? d.values.gemini : d.values.chatgpt)
          .map(([name, parts]) => [name, parts.map(text => ({ kind: 'text' as const, text }))]))
      if (kind === 'chatgpt-submit') {
        if (material === undefined) throw new ResearchActionError('canonical original report missing', 'CONFLICT')
        values.handoff_manifest_and_artifacts = [{ kind: 'artifact', artifactId: material.artifactId, sha256: material.sha256 }]
      }
      if (stage.preparedPromptId === null) throw new ResearchActionError('standard template identity missing', 'FORMAT')
      prompt = { inputId: stage.preparedPromptId, revision: run.revision,
        templateId: kind === 'gemini-plan-submit' ? 'gemini-deep-research' : 'chatgpt-verify-synthesize', values }
      rendered = this.inputs.prompt(owner, runId, prompt, new Date().toISOString()).renderedText
    }
    return this.create(owner, runId, { previewId: id, workflowId: d.workflowId, prompt,
      artifactIds: material === undefined ? [] : [material.artifactId], request: {
        runId, actionId: stage.actionId, stepId: stage.stepId, revision: run.revision, binding: run.binding,
        bindingSha256: run.bindingSha256, driverId: platform.driverId, selection: platform.selection,
        kind, target, input: rendered, preparedPromptId: stage.preparedPromptId } })
  }

  /**
   * Project retained previews within the caller-owned read transaction.
   * @param owner - Current owner.
   * @param run - Canonical run.
   * @returns Every immutable preview and its recomputed applicability within the caller-owned read transaction.
   */
  listInTransaction(owner: ResearchOwnerId, run: ResearchRunId): ResearchWorkflowPreview[] {
    this.definition(owner, run)
    return this.db.prepare('SELECT preview_id FROM research_workflow_previews WHERE run_id=? ORDER BY created_at,preview_id').all(run)
      .map(row => this.readInTransaction(owner, run, text(row.preview_id) as ResearchWorkflowPreviewId))
  }

  private definition(owner: ResearchOwnerId, runId: ResearchRunId): ResearchWorkflowDefinition {
    const value = this.inputs.definition(owner, runId)
    if (value === null) throw new ResearchActionError('canonical workflow required for preview', 'NOT_FOUND')
    return value
  }

  private validate(data: ResearchWorkflowPreviewData, definition: ResearchWorkflowDefinition): void {
    const r = data.request, stage = definition.input.stages.find(x => x.kind === r.kind)
    const platform = r.kind.startsWith('gemini-') ? definition.input.gemini : definition.input.chatgpt
    if (data.workflowId !== definition.input.workflowId || data.definitionSha256 !== definition.sha256
      || r.runId !== definition.runId || stage?.actionId !== r.actionId || stage.stepId !== r.stepId
      || stage.preparedPromptId !== r.preparedPromptId || r.binding.questionSha256 !== hash(definition.input.question)
      || r.binding.sourcesSha256 !== definition.input.sourcesSha256 || r.driverId !== platform.driverId
      || r.binding.destinationSha256 !== platform.destinationSha256 || r.target.workspace !== platform.target.workspace
      || this.inputs.requestJson(r) !== this.inputs.requestJson({ ...r, selection: platform.selection })) {
      throw new ResearchActionError('preview differs from canonical workflow stage', 'CONFLICT')
    }
    const earlier = data.prerequisites.stages.at(-1)?.action?.acceptedResource
    const target = r.kind === 'gemini-research-start' || r.kind === 'chatgpt-submit' ? earlier : platform.target
    if (target == null || (r.kind === 'gemini-research-start' || r.kind === 'chatgpt-submit') && target.conversation === null
      || r.target.workspace !== target.workspace || r.target.page !== target.page || r.target.conversation !== target.conversation) {
      throw new ResearchActionError('preview original stage target differs', 'CONFLICT')
    }
    const prompt = data.preparedPrompt
    if (r.preparedPromptId === null ? prompt !== null : prompt === null || prompt.inputId !== r.preparedPromptId
      || prompt.runId !== r.runId || prompt.revision !== r.revision || prompt.renderedText !== r.input
      || prompt.questionSha256 !== r.binding.questionSha256
      || prompt.template.id !== (r.kind === 'gemini-plan-submit' ? 'gemini-deep-research' : 'chatgpt-verify-synthesize')
      || prompt.template.version !== (r.kind === 'gemini-plan-submit' ? definition.input.templateVersions.gemini
        : definition.input.templateVersions.chatgpt)) {
      throw new ResearchActionError('preview full template differs from request', 'CONFLICT')
    }
    const role = r.kind === 'gemini-research-start' ? 'gemini-plan'
      : r.kind === 'chatgpt-upload' || r.kind === 'chatgpt-submit' ? 'gemini-report' : null
    if (role === null ? data.materials.length !== 0 : data.materials.length !== 1 || data.materials[0]?.role !== role) {
      throw new ResearchActionError('preview original stage material required', 'CONFLICT')
    }
    if (prompt !== null) {
      const original = r.kind === 'gemini-plan-submit' ? definition.input.values.gemini : definition.input.values.chatgpt
      for (const [name, parts] of Object.entries(prompt.values)) {
        if (parts.some(x => x.kind === 'artifact')) {
          if (r.kind !== 'chatgpt-submit' || name !== 'handoff_manifest_and_artifacts' || parts.length !== 1) {
            throw new ResearchActionError('preview report slot differs', 'CONFLICT')
          }
        } else if (JSON.stringify(parts.map(x => x.text)) !== JSON.stringify(original[name])) {
          throw new ResearchActionError('preview original slot text differs', 'CONFLICT')
        }
      }
    }
    const material = data.materials[0]
    const previous = data.prerequisites.stages.at(-1)
    const originalMaterial = r.kind === 'chatgpt-submit' ? previous?.material?.artifact : previous?.output?.artifact
    if (role !== null && (material === undefined || originalMaterial === undefined
      || material.artifactId !== originalMaterial.artifactId || material.version !== originalMaterial.version
      || material.sha256 !== originalMaterial.sha256 || material.text !== originalMaterial.text)) {
      throw new ResearchActionError('preview requires the exact canonical collected material', 'CONFLICT')
    }
    if (r.kind === 'chatgpt-submit') {
      if (prompt === null || material === undefined) throw new ResearchActionError('preview report template required', 'CONFLICT')
      const parts = Object.values(prompt.values).flat().filter(x => x.kind === 'artifact')
      const part = parts[0]
      if (parts.length !== 1 || part?.artifactId !== material.artifactId
        || part.version !== material.version || part.sha256 !== material.sha256 || part.text !== material.text) {
        throw new ResearchActionError('preview prompt original report differs', 'CONFLICT')
      }
    }
    else if (material !== undefined && r.input !== material.text) throw new ResearchActionError('preview full material differs', 'CONFLICT')
    if (r.kind === 'gemini-research-start' && (material === undefined || r.binding.plan?.version !== material.version
      || r.binding.plan.sha256 !== material.sha256)) throw new ResearchActionError('preview plan confirmation differs', 'CONFLICT')
  }

  private material(owner: ResearchOwnerId, runId: ResearchRunId, id: ResearchArtifactId) {
    const a = this.inputs.artifact(owner, runId, id)
    if (a.source.extent !== 'complete') throw new ResearchActionError('preview needs complete original material', 'CONFLICT')
    return { artifactId: a.artifactId, role: a.role, version: a.version, sha256: a.sha256, text: researchArtifactText(a.bytes) }
  }

  private current(owner: ResearchOwnerId, data: ResearchWorkflowPreviewData): boolean {
    const r = data.request, run = this.inputs.run(owner, r.runId)
    if (run.revision !== r.revision || run.bindingSha256 !== r.bindingSha256) return false
    const prerequisites = this.inputs.prerequisites(owner, r.runId, r.kind)
    if (!prerequisites.ready || prerequisites.key !== data.prerequisites.key) return false
    for (const a of data.materials) {
      const row = this.db.prepare('SELECT MAX(version) AS version FROM research_artifacts WHERE run_id=? AND role=?').get(r.runId, a.role)
      if (row?.version !== a.version) return false
    }
    try {
      const action = this.inputs.action(owner, r.runId, r.actionId)
      if (this.inputs.requestJson(action.request) !== this.inputs.requestJson(r)) return false
    } catch (error) {
      if (!(error instanceof ResearchActionError) || error.code !== 'NOT_FOUND') throw error
    }
    if (r.preparedPromptId !== null) {
      try {
        const p = this.inputs.prepared(owner, r.runId, r.preparedPromptId)
        const expected = data.preparedPrompt
        if (expected === null || p.revision !== r.revision || p.renderedText !== r.input
          || JSON.stringify(p.template) !== JSON.stringify(expected.template)
          || JSON.stringify(p.values) !== JSON.stringify(expected.values)) return false
      } catch (error) {
        if (!(error instanceof ResearchActionError) || error.code !== 'NOT_FOUND') throw error
      }
    }
    return true
  }

  /**
   * Retain a complete immutable preview without consuming prepared-input or action identities.
   * @param owner - Live Host owner.
   * @param runId - Canonical run.
   * @param input - Full proposed request and explicit materials.
   * @returns Immutable preview; no prepared input or action is created.
   */
  create(owner: ResearchOwnerId, runId: ResearchRunId, input: ResearchWorkflowPreviewInput): ResearchWorkflowPreview {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const definition = this.definition(owner, runId), request = this.inputs.parseRequest(input.request)
      const existing = this.db.prepare('SELECT created_at,input_json FROM research_workflow_previews WHERE run_id=? AND preview_id=?').get(runId, input.previewId)
      const at = existing === undefined ? new Date().toISOString() : text(existing.created_at)
      const data: ResearchWorkflowPreviewData = { previewId: text(input.previewId) as ResearchWorkflowPreviewId,
        workflowId: input.workflowId, definitionSha256: definition.sha256, request,
        preparedPrompt: input.prompt === null ? null : this.inputs.prompt(owner, runId, input.prompt, at),
        materials: input.artifactIds.map(id => this.material(owner, runId, id)),
        prerequisites: this.inputs.prerequisites(owner, runId, request.kind, existing === undefined ? undefined
          : object(JSON.parse(text(existing.input_json)) as unknown).prerequisites) }
      this.validate(data, definition)
      if (!this.current(owner, data)) throw new ResearchActionError('preview is no longer current', 'CONFIRMATION')
      const raw = JSON.stringify(data), row = this.db.prepare('SELECT sha256 FROM research_workflow_previews WHERE run_id=? AND preview_id=?').get(runId, data.previewId)
      if (row === undefined) this.db.prepare('INSERT INTO research_workflow_previews VALUES(?,?,?,?,?,NULL,NULL)')
        .run(runId, data.previewId, raw, hash(raw), at)
      else if (row.sha256 !== hash(raw)) throw new ResearchActionError('immutable workflow preview conflicts', 'CONFLICT')
      const retained = this.readInTransaction(owner, runId, data.previewId)
      this.db.exec('COMMIT')
      return retained
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read the original preview and recompute its applicability without changing history.
   * @param owner - Live Host owner.
   * @param runId - Original run.
   * @param id - Original preview.
   * @returns Full immutable data and recomputed currentness; confirmation is not part of its digest.
   */
  read(owner: ResearchOwnerId, runId: ResearchRunId, id: ResearchWorkflowPreviewId): ResearchWorkflowPreview {
    this.db.exec('BEGIN')
    try {
      const result = this.readInTransaction(owner, runId, id)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private readInTransaction(owner: ResearchOwnerId, runId: ResearchRunId, id: ResearchWorkflowPreviewId): ResearchWorkflowPreview {
    const definition = this.definition(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_workflow_previews WHERE run_id=? AND preview_id=?').get(runId, id)
    if (row === undefined) throw new ResearchActionError('workflow preview not found', 'NOT_FOUND')
    const raw = text(row.input_json), value = object(JSON.parse(raw) as unknown)
    if (!Array.isArray(value.materials)) throw new ResearchActionError('preview materials required', 'FORMAT')
    const materials = value.materials.map((item) => {
      const v = object(item), a = this.material(owner, runId, text(v.artifactId) as ResearchArtifactId)
      if (a.role !== v.role || a.version !== v.version || a.sha256 !== v.sha256 || a.text !== v.text) {
        throw new ResearchActionError('durable preview material differs', 'FORMAT')
      }
      return a
    })
    const data: ResearchWorkflowPreviewData = { previewId: text(value.previewId) as ResearchWorkflowPreviewId,
      workflowId: text(value.workflowId) as ResearchWorkflowPreviewData['workflowId'], definitionSha256: text(value.definitionSha256),
      request: this.inputs.parseRequest(value.request),
      preparedPrompt: value.preparedPrompt === null ? null : parseResearchPreparedPrompt(value.preparedPrompt), materials,
      prerequisites: this.inputs.prerequisites(owner, runId, this.inputs.parseRequest(value.request).kind, value.prerequisites) }
    this.validate(data, definition)
    if (data.previewId !== id || hash(raw) !== row.sha256 || JSON.stringify(data) !== raw
      || data.preparedPrompt !== null && data.preparedPrompt.preparedAt !== row.created_at) {
      throw new ResearchActionError('invalid durable workflow preview', 'FORMAT')
    }
    let confirmation: ResearchWorkflowPreview['confirmation'] = null
    if (row.confirmation_json !== null) {
      const saved = text(row.confirmation_json), c = object(JSON.parse(saved) as unknown)
      confirmation = { attribution: parseResearchJudgmentAttribution(c.attribution), confirmedAt: text(c.confirmedAt),
        previewSha256: text(c.previewSha256) }
      if (hash(saved) !== row.confirmation_sha256 || JSON.stringify(confirmation) !== saved
        || confirmation.previewSha256 !== hash(raw)
        || confirmation.attribution.channel !== 'human' || confirmation.attribution.ownerId !== owner
        || !Number.isFinite(Date.parse(confirmation.confirmedAt))) throw new ResearchActionError('invalid preview confirmation', 'FORMAT')
    } else if (row.confirmation_sha256 !== null) throw new ResearchActionError('orphan preview confirmation digest', 'FORMAT')
    const isCurrent = this.current(owner, data), run = this.inputs.run(owner, runId)
    return { input: data, sha256: hash(raw), isCurrent, confirmed: isCurrent && run.confirmed && confirmation !== null, confirmation }
  }

  /**
   * Confirm the exact current preview through the trusted human entry.
   * @param owner - Live Host owner.
   * @param runId - Canonical run.
   * @param id - Exact preview.
   * @param sha256 - Reviewed full bytes.
   * @param attribution - Actual trusted human entry attribution, separate from imported data.
   * @returns Separately confirmed preview.
   */
  confirm(owner: ResearchOwnerId, runId: ResearchRunId, id: ResearchWorkflowPreviewId, sha256: string,
    attribution: ResearchJudgmentAttribution): ResearchWorkflowPreview {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const preview = this.readInTransaction(owner, runId, id), actual = parseResearchJudgmentAttribution(attribution)
      if (!preview.isCurrent || preview.sha256 !== sha256 || !this.inputs.run(owner, runId).confirmed
        || actual.channel !== 'human' || actual.ownerId !== owner) throw new ResearchActionError('preview confirmation is not current', 'CONFIRMATION')
      if (preview.confirmation === null) {
        const raw = JSON.stringify({ attribution: actual, confirmedAt: new Date().toISOString(), previewSha256: preview.sha256 })
        this.db.prepare('UPDATE research_workflow_previews SET confirmation_json=?,confirmation_sha256=? WHERE run_id=? AND preview_id=?')
          .run(raw, hash(raw), runId, id)
      }
      const result = this.readInTransaction(owner, runId, id)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Atomically freeze the original template input after current confirmations pass.
   * @param owner - Live Host owner.
   * @param runId - Canonical run.
   * @param id - Confirmed preview.
   * @param sha256 - Exact reviewed bytes.
   * @returns Fixed request after transactionally preparing its original template; no external action is admitted here.
   */
  freeze(owner: ResearchOwnerId, runId: ResearchRunId, id: ResearchWorkflowPreviewId, sha256: string): ResearchActionRequest {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const preview = this.readInTransaction(owner, runId, id)
      if (!preview.confirmed || preview.sha256 !== sha256) throw new ResearchActionError('preview cannot freeze', 'CONFIRMATION')
      const p = preview.input.preparedPrompt
      if (p !== null) this.inputs.prepare(owner, runId, { inputId: p.inputId, revision: p.revision, templateId: p.template.id,
        values: Object.fromEntries(Object.entries(p.values).map(([name, parts]) => [name, parts.map(part => part.kind === 'text'
          ? { kind: 'text' as const, text: part.text } : { kind: 'artifact' as const, artifactId: part.artifactId, sha256: part.sha256 })])) })
      this.db.exec('COMMIT')
      return preview.input.request
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
