/** Canonical workflow definitions share the action owner's SQLite database. */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { ResearchActionError, type ResearchOwnerId, type ResearchRunId, type ResearchActionRun,
  type ResearchWorkflowDefinition, type ResearchWorkflowDefinitionInput, type ResearchWorkflowPlatform,
  type ResearchWorkflowStage, type ResearchWorkflowId, type ResearchWorkflowObservationId, type ResearchWorkflowOutput,
  type ResearchWorkflowOutputInput, type ResearchActionId, type ResearchActionSnapshot, type ResearchAcceptedResource,
  type ResearchArtifactId, type ResearchArtifactInput, type ResearchArtifactSnapshot, type ResearchCaptureSource,
} from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchCapture, researchArtifactHash, researchArtifactText } from './artifact.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const kinds = ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'] as const

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('workflow object required', 'FORMAT')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || typeof value === 'string'
    && Buffer.from(value).toString('utf8') !== value) throw new ResearchActionError('invalid workflow text', 'FORMAT')
  return value
}

function platform(value: unknown): ResearchWorkflowPlatform {
  const v = object(value), s = object(v.selection), e = object(s.effort), t = object(v.target)
  if (!Array.isArray(s.tools) || !['required', 'not-requested', 'not-applicable'].includes(text(e.kind))) {
    throw new ResearchActionError('invalid workflow selection', 'FORMAT')
  }
  return { driverId: text(v.driverId) as ResearchWorkflowPlatform['driverId'],
    selection: { model: text(s.model), mode: text(s.mode), tools: s.tools.map(x => text(x)),
      effort: e.kind === 'required' ? { kind: 'required', value: text(e.value) }
        : { kind: e.kind as 'not-requested' | 'not-applicable' } },
    target: { workspace: text(t.workspace), page: text(t.page), conversation: t.conversation === null ? null : text(t.conversation) },
    destinationSha256: text(v.destinationSha256) }
}

function slots(value: unknown): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(object(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, parts]) => {
    text(key)
    if (!Array.isArray(parts) || parts.length === 0) throw new ResearchActionError('workflow slot parts required', 'FORMAT')
    return [key, parts.map(x => text(x, true))]
  }))
}

function definition(value: unknown): ResearchWorkflowDefinitionInput {
  const v = object(value), versions = object(v.templateVersions), values = object(v.values)
  if (!Array.isArray(v.stages) || v.stages.length !== kinds.length) {
    throw new ResearchActionError('all four workflow stage identities required', 'FORMAT')
  }
  const stages = v.stages.map((raw): ResearchWorkflowStage => {
    const s = object(raw), kind = text(s.kind)
    if (!(kinds as readonly string[]).includes(kind)) throw new ResearchActionError('unknown workflow stage', 'FORMAT')
    const modelStage = kind === 'gemini-plan-submit' || kind === 'chatgpt-submit'
    if (modelStage === (s.preparedPromptId === null)) throw new ResearchActionError('workflow prepared input identity differs', 'FORMAT')
    return { kind: kind as ResearchWorkflowStage['kind'], actionId: text(s.actionId) as ResearchWorkflowStage['actionId'],
      stepId: text(s.stepId) as ResearchWorkflowStage['stepId'],
      preparedPromptId: s.preparedPromptId === null ? null : text(s.preparedPromptId) as ResearchWorkflowStage['preparedPromptId'] }
  })
  if (new Set(stages.map(x => x.kind)).size !== 4 || new Set(stages.map(x => x.actionId)).size !== 4
    || new Set(stages.map(x => x.stepId)).size !== 4
    || new Set(stages.filter(x => x.preparedPromptId !== null).map(x => x.preparedPromptId)).size !== 2) {
    throw new ResearchActionError('duplicate workflow stage identity', 'FORMAT')
  }
  return { workflowId: text(v.workflowId) as ResearchWorkflowDefinitionInput['workflowId'], sessionId: text(v.sessionId),
    question: text(v.question), sourcesSha256: text(v.sourcesSha256), gemini: platform(v.gemini), chatgpt: platform(v.chatgpt),
    templateVersions: { gemini: text(versions.gemini), chatgpt: text(versions.chatgpt) },
    values: { gemini: slots(values.gemini), chatgpt: slots(values.chatgpt) },
    stages: stages.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind)) }
}

function resource(value: unknown): ResearchAcceptedResource {
  const v = object(value)
  return { workspace: text(v.workspace), page: text(v.page), evidence: text(v.evidence),
    conversation: v.conversation === null ? null : text(v.conversation), report: v.report === null ? null : text(v.report) }
}

function source(value: unknown): ResearchCaptureSource {
  const v = parseResearchCapture(value)
  if (v.method === 'manual-import') throw new ResearchActionError('standard output requires an actual resource collector', 'FORMAT')
  return { page: v.page, conversation: v.conversation, method: v.method, capturedAt: v.capturedAt,
    extent: v.extent, endEvidence: v.endEvidence }
}

function role(kind: ResearchWorkflowStage['kind']): ResearchArtifactInput['role'] {
  const value = { 'gemini-plan-submit': 'gemini-plan', 'gemini-research-start': 'gemini-report',
    'chatgpt-submit': 'chatgpt-report', 'chatgpt-upload': null } as const
  const selected = value[kind]
  if (selected === null) throw new ResearchActionError('upload has no workflow output report', 'CONFLICT')
  return selected
}

interface OutputHeader {
  readonly workflowId: ResearchWorkflowId
  readonly definitionSha256: string
  readonly actionId: ResearchActionId
  readonly observationId: ResearchWorkflowObservationId
  readonly requestSha256: string
  readonly resource: ResearchAcceptedResource
  readonly source: ResearchCaptureSource
  readonly artifactSha256: string
}

const artifactId = (h: OutputHeader): ResearchArtifactId =>
  ('workflow-output-' + hash(JSON.stringify([h.workflowId, h.actionId, h.observationId]))) as ResearchArtifactId

/** One canonical workflow and Session per owned run, without a second action admission state. */
export class ResearchWorkflowRecords {
  /**
   * @param db - Existing action-owner database; no separate connection or lifecycle.
   * @param run - Owner-checked current run lookup.
   * @param action - Owner-checked original action lookup.
   * @param append - Original artifact append inside the caller-owned transaction.
   * @param artifact - Original full owner-checked artifact read.
   */
  constructor(private readonly db: DatabaseSync,
    private readonly run: (owner: ResearchOwnerId, id: ResearchRunId) => ResearchActionRun,
    private readonly action: (owner: ResearchOwnerId, id: ResearchRunId, action: ResearchActionId) => ResearchActionSnapshot,
    private readonly append: (owner: ResearchOwnerId, id: ResearchRunId, input: ResearchArtifactInput) => ResearchArtifactSnapshot,
    private readonly artifact: (owner: ResearchOwnerId, id: ResearchRunId, artifact: ResearchArtifactId) => ResearchArtifactSnapshot) {}

  /**
   * Claim the unique canonical owner, run and Session definition.
   * @param owner - Current callable Host owner.
   * @param runId - Existing run; a new workflow requires a new run.
   * @param input - Full initial definition; imported confirmation fields are excluded.
   * @returns Exact existing or newly retained canonical definition.
   */
  claim(owner: ResearchOwnerId, runId: ResearchRunId, input: unknown): ResearchWorkflowDefinition {
    const fixed = definition(input), raw = JSON.stringify(fixed)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.run(owner, runId)
      if (run.binding.questionSha256 !== hash(fixed.question) || run.binding.sourcesSha256 !== fixed.sourcesSha256) {
        throw new ResearchActionError('workflow original question or sources differ from run', 'CONFLICT')
      }
      const existing = this.read(owner, runId)
      if (existing !== null) {
        if (existing.sha256 !== hash(raw)) throw new ResearchActionError('run already has another canonical workflow or Session', 'CONFLICT')
      }
      else this.db.prepare('INSERT INTO research_workflows VALUES(?,?,?,?,?)').run(
        runId, fixed.workflowId, fixed.sessionId, raw, hash(raw))
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const retained = this.read(owner, runId)
    if (retained === null) throw new ResearchActionError('canonical workflow disappeared', 'NOT_FOUND')
    return retained
  }

  /**
   * Read the original canonical definition under current owner access.
   * @param owner - Current callable Host owner; saved identifiers do not grant access.
   * @param runId - Existing run.
   * @returns Original canonical definition, or null when no workflow has been claimed.
   */
  read(owner: ResearchOwnerId, runId: ResearchRunId): ResearchWorkflowDefinition | null {
    this.run(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_workflows WHERE run_id=?').get(runId)
    if (row === undefined) return null
    const raw = text(row.definition_json), input = definition(JSON.parse(raw) as unknown)
    if (hash(raw) !== row.sha256 || JSON.stringify(input) !== raw
      || input.workflowId !== row.workflow_id || input.sessionId !== row.session_id) {
      throw new ResearchActionError('invalid durable canonical workflow', 'FORMAT')
    }
    return { runId, input, sha256: hash(raw) }
  }

  /**
   * The enclosing transaction owns both the original artifact and its immutable observation association.
   * @param owner - Owner admitted by the current Host before collection.
   * @param runId - Canonical run.
   * @param workflowId - Original canonical workflow.
   * @param input - Actual original-resource observation and exact bytes.
   * @returns Retained full output, including earlier partial captures under their own identities.
   */
  capture(owner: ResearchOwnerId, runId: ResearchRunId, workflowId: ResearchWorkflowId,
    input: ResearchWorkflowOutputInput): ResearchWorkflowOutput {
    const bytes = Uint8Array.from(input.bytes)
    researchArtifactText(bytes)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const canonical = this.read(owner, runId)
      if (canonical === null) throw new ResearchActionError('canonical workflow not found', 'NOT_FOUND')
      const header = this.header(owner, runId, workflowId, { ...input, workflowId,
        definitionSha256: canonical.sha256, artifactSha256: researchArtifactHash(bytes) })
      const raw = JSON.stringify(header), id = artifactId(header)
      let row = this.db.prepare('SELECT * FROM research_workflow_outputs WHERE run_id=? AND action_id=? AND observation_id=?')
        .get(runId, header.actionId, header.observationId)
      if (row !== undefined) {
        if (row.input_json !== raw || row.sha256 !== hash(raw)) {
          throw new ResearchActionError('immutable workflow capture observation conflicts', 'CONFLICT')
        }
      }
      else {
        const action = this.action(owner, runId, header.actionId), outputRole = role(action.request.kind)
        const latest = this.db.prepare('SELECT MAX(version) AS version FROM research_artifacts WHERE run_id=? AND role=?')
          .get(runId, outputRole)?.version ?? 0
        if (typeof latest !== 'number' || !Number.isSafeInteger(latest) || latest < 0) {
          throw new ResearchActionError('invalid workflow artifact version', 'FORMAT')
        }
        this.append(owner, runId, { artifactId: id, actionId: header.actionId, role: outputRole,
          expectedVersion: latest, source: header.source, bytes })
        this.db.prepare('INSERT INTO research_workflow_outputs(run_id,workflow_id,action_id,observation_id,artifact_id,input_json,sha256) '
          + 'VALUES(?,?,?,?,?,?,?)').run(runId, workflowId, header.actionId, header.observationId, id, raw, hash(raw))
        row = this.db.prepare('SELECT * FROM research_workflow_outputs WHERE run_id=? AND artifact_id=?').get(runId, id)
      }
      if (row === undefined) throw new ResearchActionError('workflow output disappeared', 'FORMAT')
      const output = this.output(owner, runId, workflowId, row)
      this.db.exec('COMMIT')
      return output
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Read all original capture versions without invoking a Driver.
   * @param owner - Current owner capability.
   * @param runId - Owned canonical run.
   * @param workflowId - Original workflow.
   * @returns Full immutable output history, including prior partial captures.
   */
  outputs(owner: ResearchOwnerId, runId: ResearchRunId, workflowId: ResearchWorkflowId): ResearchWorkflowOutput[] {
    const canonical = this.read(owner, runId)
    if (canonical?.input.workflowId !== workflowId) throw new ResearchActionError('canonical workflow differs', 'CONFLICT')
    return this.db.prepare('SELECT * FROM research_workflow_outputs WHERE run_id=? ORDER BY seq').all(runId)
      .map(row => this.output(owner, runId, workflowId, row))
  }


  private header(owner: ResearchOwnerId, runId: ResearchRunId, workflowId: ResearchWorkflowId, value: unknown): OutputHeader {
    const canonical = this.read(owner, runId), v = object(value)
    if (canonical?.input.workflowId !== workflowId || v.workflowId !== workflowId || v.definitionSha256 !== canonical.sha256) {
      throw new ResearchActionError('workflow capture definition differs', 'CONFLICT')
    }
    const actionId = text(v.actionId) as ResearchActionId, action = this.action(owner, runId, actionId)
    const stage = canonical.input.stages.find(x => x.actionId === actionId)
    const retained = resource(v.resource), current = action.acceptedResource, capture = source(v.source)
    if (stage?.kind !== action.request.kind || stage.stepId !== action.request.stepId
      || stage.preparedPromptId !== action.request.preparedPromptId || action.state !== 'completed' || current === null
      || v.requestSha256 !== action.inputSha256 || JSON.stringify(retained) !== JSON.stringify(resource(current))
      || capture.page !== retained.page || retained.conversation !== null && capture.conversation !== retained.conversation) {
      throw new ResearchActionError('workflow output does not belong to the completed original action', 'CONFLICT')
    }
    role(action.request.kind)
    return { workflowId, definitionSha256: canonical.sha256, actionId,
      observationId: text(v.observationId) as ResearchWorkflowObservationId, requestSha256: action.inputSha256,
      resource: retained, source: capture, artifactSha256: text(v.artifactSha256) }
  }

  private rowHeader(owner: ResearchOwnerId, runId: ResearchRunId, workflowId: ResearchWorkflowId,
    row: Record<string, unknown>): OutputHeader {
    const raw = text(row.input_json), header = this.header(owner, runId, workflowId, JSON.parse(raw) as unknown)
    if (hash(raw) !== row.sha256 || JSON.stringify(header) !== raw || row.workflow_id !== workflowId
      || row.action_id !== header.actionId || row.observation_id !== header.observationId || row.artifact_id !== artifactId(header)) {
      throw new ResearchActionError('invalid durable workflow output association', 'FORMAT')
    }
    return header
  }

  private output(owner: ResearchOwnerId, runId: ResearchRunId, workflowId: ResearchWorkflowId,
    row: Record<string, unknown>): ResearchWorkflowOutput {
    const header = this.rowHeader(owner, runId, workflowId, row)
    const artifact = this.artifact(owner, runId, artifactId(header))
    if (artifact.actionId !== header.actionId || artifact.requestSha256 !== header.requestSha256
      || artifact.role !== role(this.action(owner, runId, header.actionId).request.kind)
      || artifact.sha256 !== header.artifactSha256 || JSON.stringify(artifact.source) !== JSON.stringify(header.source)) {
      throw new ResearchActionError('workflow output artifact association differs', 'FORMAT')
    }
    return { workflowId, observationId: header.observationId, resource: header.resource, artifact }
  }

}
