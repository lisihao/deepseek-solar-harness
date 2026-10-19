/** Durable research action data; stored confirmations never grant Host execution authority. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  ResearchActionError, type ResearchRunId, type ResearchActionId, type ResearchOwnerId,
  type ResearchDriverSelection, type ResearchAcceptedResource, type ResearchConfirmationBinding,
  type ResearchActionRun, type ResearchActionRequest,
  type ResearchActionState, type ResearchActionSnapshot, type ResearchActionObservation, type ResearchObservationRecord,
  type ResearchArtifactId, type ResearchArtifactInput, type ResearchArtifactSnapshot,
  type ResearchClaimInventory, type ResearchClaimInventoryInput, type ResearchClaimJudgment, type ResearchJudgmentId,
  type ResearchDriverQualification, type ResearchQualificationRecord, type ResearchJudgmentAttribution,
  type ResearchPromptPreparation, type ResearchPreparedPrompt, type ResearchPromptInputId, type ResearchRetainedPromptPart,
  type ResearchWorkflowState,
} from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchCapture, researchArtifactHash, researchArtifactText } from './artifact.ts'
import { parseResearchClaimInventory, parseResearchClaimJudgment, parseResearchJudgmentAttribution,
  validateResearchClaimChanges } from './claim-inventory.ts'
import { parseResearchQualification } from './qualification.ts'
import { ResearchSourceRecords } from './source-read.ts'
import { ResearchCitationRecords } from './citation.ts'
import { ResearchDispositionRecords } from './disposition.ts'
import { ResearchFinalMaps } from './final-map.ts'
import { ResearchFinalDecisions } from './final-decision.ts'
import { ResearchDeliveryRecords } from './delivery.ts'
import { ResearchWorkflowRecords } from './workflow.ts'
import { ResearchWorkflowPreviews } from './workflow-preview.ts'
import { ResearchWorkflowDeliveries } from './workflow-delivery.ts'
import type { ResearchFinalInputs } from './final-status.ts'
import { parseResearchPreparedPrompt, readResearchPromptTemplate, renderResearchPrompt } from './prompt.ts'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

function effortValue(effort: ResearchDriverSelection['effort']): ResearchDriverSelection['effort'] {
  return effort.kind === 'required' ? { kind: effort.kind, value: effort.value } : { kind: effort.kind }
}

function parseResource(raw: string | null): ResearchAcceptedResource | null {
  if (raw === null) return null
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid accepted resource', 'FORMAT')
  }
  const record = value as Record<string, unknown>
  for (const key of ['workspace', 'page', 'evidence']) {
    if (!text(record, key)) throw new ResearchActionError('empty accepted resource field', 'FORMAT')
  }
  for (const key of ['conversation', 'report']) {
    if (record[key] !== null && (typeof record[key] !== 'string' || !record[key])) {
      throw new ResearchActionError('invalid accepted resource identity', 'FORMAT')
    }
  }
  return { workspace: text(record, 'workspace'), page: text(record, 'page'),
    conversation: record.conversation as string | null, report: record.report as string | null, evidence: text(record, 'evidence') }
}

function resourceJson(resource: ResearchAcceptedResource | null): string | null {
  return resource === null ? null : JSON.stringify({ workspace: resource.workspace, page: resource.page,
    conversation: resource.conversation, report: resource.report, evidence: resource.evidence })
}

function bindingValue(binding: ResearchConfirmationBinding): ResearchConfirmationBinding {
  return {
    questionSha256: binding.questionSha256, sourcesSha256: binding.sourcesSha256,
    modeSha256: binding.modeSha256, destinationSha256: binding.destinationSha256,
    plan: binding.plan === null ? null : { version: binding.plan.version, sha256: binding.plan.sha256 },
  }
}

function bindingJson(binding: ResearchConfirmationBinding): string {
  return JSON.stringify(bindingValue(binding))
}

function requestJson(request: ResearchActionRequest): string {
  return JSON.stringify({
    runId: request.runId, actionId: request.actionId, stepId: request.stepId, revision: request.revision,
    bindingSha256: request.bindingSha256, binding: bindingValue(request.binding), kind: request.kind, driverId: request.driverId,
    selection: { model: request.selection.model, mode: request.selection.mode, effort: effortValue(request.selection.effort),
      tools: [...request.selection.tools].sort() },
    target: { workspace: request.target.workspace, page: request.target.page, conversation: request.target.conversation },
    input: request.input, preparedPromptId: request.preparedPromptId,
  })
}

/**
 * Hash the complete immutable action, including retained confirmation, Driver and selected mode.
 * @param request - Complete action input.
 * @returns Stable digest used to bind Driver qualification and original-target receipts.
 */
export function researchActionFingerprint(request: ResearchActionRequest): string { return digest(requestJson(request)) }

/**
 * Bind the explicit selected Driver, model, mode and enabled tools into run confirmation data.
 * @param driverId - Explicit registered Driver identity.
 * @param selection - Host-selected settings; enabled-tool order is immaterial.
 * @returns Stable selected-mode digest, without proving website availability.
 */
export function researchModeFingerprint(driverId: ResearchActionRequest['driverId'], selection: ResearchDriverSelection): string {
  return digest(JSON.stringify({ driverId, model: selection.model, mode: selection.mode, effort: effortValue(selection.effort),
    tools: [...selection.tools].sort() }))
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new ResearchActionError(`invalid research column ${key}`, 'FORMAT')
  return value
}

function parseBinding(raw: string): ResearchConfirmationBinding {
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid research confirmation record', 'FORMAT')
  }
  const record = value as Record<string, unknown>
  for (const key of ['questionSha256', 'sourcesSha256', 'modeSha256', 'destinationSha256']) text(record, key)
  if (record.plan !== null) {
    if (typeof record.plan !== 'object' || Array.isArray(record.plan)) {
      throw new ResearchActionError('invalid research plan binding', 'FORMAT')
    }
    const plan = record.plan as Record<string, unknown>
    text(plan, 'sha256')
    if (!Number.isSafeInteger(plan.version) || (plan.version as number) < 1) {
      throw new ResearchActionError('invalid research plan version', 'FORMAT')
    }
  }
  return record as unknown as ResearchConfirmationBinding
}

function parseRequest(raw: string): ResearchActionRequest {
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid research action record', 'FORMAT')
  }
  const record = value as Record<string, unknown>
  for (const key of ['runId', 'actionId', 'stepId', 'bindingSha256', 'kind', 'input', 'driverId']) text(record, key)
  if (!['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].includes(text(record, 'kind'))
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    || record.target === null || typeof record.target !== 'object' || Array.isArray(record.target)) {
    throw new ResearchActionError('invalid research action fields', 'FORMAT')
  }
  if (record.preparedPromptId !== null && (typeof record.preparedPromptId !== 'string' || !record.preparedPromptId)) {
    throw new ResearchActionError('invalid prepared input reference', 'FORMAT')
  }
  const target = record.target as Record<string, unknown>
  text(target, 'workspace')
  text(target, 'page')
  if (target.conversation !== null && typeof target.conversation !== 'string') {
    throw new ResearchActionError('invalid research conversation identity', 'FORMAT')
  }
  if (record.binding === null || typeof record.binding !== 'object' || Array.isArray(record.binding)) {
    throw new ResearchActionError('invalid research confirmation snapshot', 'FORMAT')
  }
  const binding = parseBinding(JSON.stringify(record.binding))
  if (digest(bindingJson(binding)) !== record.bindingSha256) {
    throw new ResearchActionError('research action confirmation snapshot conflicts', 'FORMAT')
  }
  if (record.selection === null || typeof record.selection !== 'object' || Array.isArray(record.selection)) {
    throw new ResearchActionError('invalid research Driver selection', 'FORMAT')
  }
  const selection = record.selection as Record<string, unknown>
  if (!text(record, 'driverId') || !text(selection, 'model') || !text(selection, 'mode')
    || !Array.isArray(selection.tools) || selection.tools.some(value => typeof value !== 'string' || !value)
    || new Set(selection.tools).size !== selection.tools.length) {
    throw new ResearchActionError('invalid research Driver selection', 'FORMAT')
  }
  const effort = selection.effort
  if (effort === null || typeof effort !== 'object' || Array.isArray(effort)) {
    throw new ResearchActionError('invalid requested effort', 'FORMAT')
  }
  const requested = effort as Record<string, unknown>
  if (!['required', 'not-requested', 'not-applicable'].includes(text(requested, 'kind'))
    || requested.kind === 'required' && !text(requested, 'value')) {
    throw new ResearchActionError('invalid requested effort', 'FORMAT')
  }
  return record as unknown as ResearchActionRequest
}

/** SQLite owner of run revisions, confirmations, and non-replayable external action intents. */
export class ResearchActionStore {
  private readonly db: DatabaseSync
  /** Source records share this database, run ownership and close lifecycle. */
  readonly sourceReads: ResearchSourceRecords
  /** Exact-source judgments use this owner's existing database and inventory records. */
  readonly citations: ResearchCitationRecords
  /** Counterevidence treatment shares this database and original judgment records. */
  readonly dispositions: ResearchDispositionRecords
  /** Final mappings share this database and exact artifact/inventory ownership. */
  readonly finalMaps: ResearchFinalMaps
  /** Computed current status and immutable decisions share the same SQLite owner. */
  readonly finalDecisions: ResearchFinalDecisions
  /** Actual Driver delivery observations share this database without owning action transitions. */
  readonly deliveries: ResearchDeliveryRecords
  /** Canonical workflow identity uses the same SQLite run owner. */
  readonly workflows: ResearchWorkflowRecords
  /** Immutable complete previews and independent human confirmation share the original database. */
  readonly workflowPreviews: ResearchWorkflowPreviews
  /** Standard delivery gates and exact human treatments share the original action owner. */
  readonly workflowDeliveries: ResearchWorkflowDeliveries

  /**
   * @param filename - Explicit private database path; unrelated or unsupported formats are refused.
   */
  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    try {
      this.db.exec('PRAGMA foreign_keys=ON')
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version === 0) {
        const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (existing.length > 0) throw new ResearchActionError('unversioned research database is not empty', 'FORMAT')
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE research_runs (
            run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL,
            binding_json TEXT NOT NULL, confirmed_sha256 TEXT
          );
          CREATE TABLE research_prepared_prompts (
            run_id TEXT NOT NULL REFERENCES research_runs(run_id), input_id TEXT NOT NULL,
            prepared_at TEXT NOT NULL, prepared_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            PRIMARY KEY(run_id, input_id)
          );
          CREATE TABLE research_actions (
            run_id TEXT NOT NULL REFERENCES research_runs(run_id), action_id TEXT NOT NULL,
            revision INTEGER NOT NULL, step_id TEXT NOT NULL,
            request_json TEXT NOT NULL, input_sha256 TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('unknown','accepted','completed','not-sent')), receipt TEXT, accepted_resource_json TEXT,
            PRIMARY KEY(run_id, action_id), UNIQUE(run_id, revision, step_id)
          );
          CREATE TABLE research_action_observations (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, action_id TEXT NOT NULL,
            state TEXT NOT NULL, receipt TEXT NOT NULL, accepted_resource_json TEXT,
            FOREIGN KEY(run_id, action_id) REFERENCES research_actions(run_id, action_id)
          );
          CREATE TABLE research_driver_qualifications (
            run_id TEXT NOT NULL, action_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL,
            qualification_json TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(run_id, action_id),
            FOREIGN KEY(run_id, action_id) REFERENCES research_actions(run_id, action_id)
          );
          CREATE TABLE research_artifacts (
            run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, action_id TEXT NOT NULL,
            request_sha256 TEXT NOT NULL, role TEXT NOT NULL, version INTEGER NOT NULL,
            source_json TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL,
            PRIMARY KEY(run_id, artifact_id), UNIQUE(run_id, role, version),
            FOREIGN KEY(run_id, action_id) REFERENCES research_actions(run_id, action_id)
          );
          CREATE TABLE research_claim_inventories (
            run_id TEXT NOT NULL REFERENCES research_runs(run_id), version INTEGER NOT NULL,
            run_revision INTEGER NOT NULL, inventory_json TEXT NOT NULL, sha256 TEXT NOT NULL, confirmed_sha256 TEXT,
            PRIMARY KEY(run_id, version)
          );
          CREATE TABLE research_claim_judgments (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, judgment_id TEXT NOT NULL,
            inventory_version INTEGER NOT NULL, claim_id TEXT NOT NULL, judgment_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            attribution_json TEXT NOT NULL, attribution_sha256 TEXT NOT NULL,
            UNIQUE(run_id, judgment_id),
            FOREIGN KEY(run_id, inventory_version) REFERENCES research_claim_inventories(run_id, version)
          );
          CREATE TABLE research_source_reads (
            run_id TEXT NOT NULL REFERENCES research_runs(run_id), read_id TEXT NOT NULL, requested_url TEXT NOT NULL,
            request_json TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(run_id,read_id)
          );
          CREATE TABLE research_source_observations (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, read_id TEXT NOT NULL, observation_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            FOREIGN KEY(run_id,read_id) REFERENCES research_source_reads(run_id,read_id)
          );
          CREATE TABLE research_source_visits (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, read_id TEXT NOT NULL, visit_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            FOREIGN KEY(run_id,read_id) REFERENCES research_source_reads(run_id,read_id)
          );
          CREATE TABLE research_citations (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, citation_id TEXT NOT NULL, inventory_version INTEGER NOT NULL,
            input_json TEXT NOT NULL, sha256 TEXT NOT NULL, attribution_json TEXT NOT NULL, attribution_sha256 TEXT NOT NULL,
            recorded_at TEXT NOT NULL, UNIQUE(run_id,citation_id),
            FOREIGN KEY(run_id,inventory_version) REFERENCES research_claim_inventories(run_id,version)
          );
          CREATE TABLE research_dispositions (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), disposition_id TEXT NOT NULL,
            target_key TEXT NOT NULL, input_json TEXT NOT NULL, sha256 TEXT NOT NULL, attribution_json TEXT NOT NULL,
            attribution_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(run_id,disposition_id)
          );
          CREATE TABLE research_final_maps (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), map_id TEXT NOT NULL,
            input_json TEXT NOT NULL, sha256 TEXT NOT NULL, attribution_json TEXT NOT NULL, attribution_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL,
            confirmation_json TEXT, confirmation_sha256 TEXT, UNIQUE(run_id,map_id)
          );
          CREATE TABLE research_final_decisions (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), decision_id TEXT NOT NULL,
            status_json TEXT NOT NULL, sha256 TEXT NOT NULL, attribution_json TEXT NOT NULL, attribution_sha256 TEXT NOT NULL,
            recorded_at TEXT NOT NULL, UNIQUE(run_id,decision_id)
          );
          CREATE TABLE research_deliveries (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, action_id TEXT NOT NULL,
            input_json TEXT NOT NULL, sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL,
            UNIQUE(run_id,action_id,sha256),
            FOREIGN KEY(run_id,action_id) REFERENCES research_actions(run_id,action_id)
          );
          CREATE TABLE research_workflows (
            run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id), workflow_id TEXT NOT NULL, session_id TEXT NOT NULL,
            definition_json TEXT NOT NULL, sha256 TEXT NOT NULL
          );
          CREATE TABLE research_workflow_outputs (
            seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_workflows(run_id), workflow_id TEXT NOT NULL,
            action_id TEXT NOT NULL, observation_id TEXT NOT NULL, artifact_id TEXT NOT NULL, input_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            UNIQUE(run_id,action_id,observation_id), UNIQUE(run_id,artifact_id),
            FOREIGN KEY(run_id,artifact_id) REFERENCES research_artifacts(run_id,artifact_id)
          );
          CREATE TABLE research_workflow_previews (
            run_id TEXT NOT NULL REFERENCES research_workflows(run_id), preview_id TEXT NOT NULL,
            input_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
            confirmation_json TEXT, confirmation_sha256 TEXT, PRIMARY KEY(run_id,preview_id)
          );
          CREATE TABLE research_workflow_delivery_dispositions (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES research_workflows(run_id),
            action_id TEXT NOT NULL, disposition_id TEXT NOT NULL, input_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            UNIQUE(run_id,disposition_id), FOREIGN KEY(run_id,action_id) REFERENCES research_actions(run_id,action_id)
          );
          PRAGMA user_version=19;
          COMMIT;`)
      }
      else if (version !== 19) throw new ResearchActionError('unsupported research database version', 'FORMAT')
      this.sourceReads = new ResearchSourceRecords(this.db, (owner, run) => this.inspect(owner, run))
      this.citations = new ResearchCitationRecords(this.db,
        (owner, run, version) => this.readClaimInventory(owner, run, version),
        (owner, run, read) => this.sourceReads.read(owner, run, read))
      this.dispositions = new ResearchDispositionRecords(this.db,
        (owner, run, version) => this.readClaimInventory(owner, run, version),
        (owner, run, id) => this.citations.read(owner, run, id),
        (owner, run, id) => this.readCounterJudgment(owner, run, id),
        (owner, run, id) => this.finalMaps.read(owner, run, id))
      this.finalMaps = new ResearchFinalMaps(this.db, {
        run: (owner, run) => this.inspect(owner, run),
        inventory: (owner, run, version) => this.readClaimInventory(owner, run, version),
        artifact: (owner, run, id) => this.readArtifact(owner, run, id),
        latestArtifact: (owner, run, role) => this.latestReport(owner, run, role),
        citation: (owner, run, id) => this.citations.read(owner, run, id),
        disposition: (owner, run, id) => this.dispositions.read(owner, run, id),
      })
      this.finalDecisions = new ResearchFinalDecisions(this.db, (owner, run) => this.finalInputs(owner, run))
      this.deliveries = new ResearchDeliveryRecords(this.db, (owner, run, action) => this.readAction(owner, run, action))
      this.workflows = new ResearchWorkflowRecords(this.db, (owner, run) => this.inspect(owner, run),
        (owner, run, action) => this.readAction(owner, run, action),
        (owner, run, input) => this.captureArtifactInTransaction(owner, run, input),
        (owner, run, artifact) => this.readArtifact(owner, run, artifact))
      this.workflowDeliveries = new ResearchWorkflowDeliveries(this.db, {
        definition: (owner, run) => this.workflows.read(owner, run),
        action: (owner, run, id) => this.readAction(owner, run, id),
        prepared: (owner, run, id) => this.readPreparedPrompt(owner, run, id),
        history: (owner, run, id) => this.deliveries.read(owner, run, id),
        outputs: (owner, run, id) => this.workflows.outputs(owner, run, id), requestJson,
      })
      this.workflowPreviews = new ResearchWorkflowPreviews(this.db, {
        modeFingerprint: researchModeFingerprint, revise: (owner, run, revision, binding) => this.revise(owner, run, revision, binding),
        prerequisites: (owner, run, kind, saved) => this.workflowDeliveries.prerequisites(owner, run, kind, saved),
        run: (owner, run) => this.inspect(owner, run),
        definition: (owner, run) => this.workflows.read(owner, run),
        artifact: (owner, run, id) => this.readArtifact(owner, run, id),
        action: (owner, run, id) => this.readAction(owner, run, id),
        parseRequest: value => parseRequest(requestJson(parseRequest(JSON.stringify(value)))), requestJson,
        prompt: (owner, run, input, at) => this.resolvePrompt(owner, run, input, at),
        prepare: (owner, run, input) => this.preparePromptInTransaction(owner, run, input),
        prepared: (owner, run, id) => this.readPreparedPrompt(owner, run, id),
      })
    }
    catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * Project the current standard workflow in the owning SQLite read snapshot.
   * @param owner - Current live owner.
   * @param runId - Canonical run.
   * @returns Complete standard-flow state from one original SQLite read snapshot, without historical completion overrides.
   */
  readWorkflowState(owner: ResearchOwnerId, runId: ResearchRunId): ResearchWorkflowState {
    this.db.exec('BEGIN')
    try {
      const run = this.inspect(owner, runId), definition = this.workflows.read(owner, runId)
      if (definition === null) throw new ResearchActionError('canonical workflow not found', 'NOT_FOUND')
      const stages = definition.input.stages.map(s => this.workflowDeliveries.readInTransaction(owner, runId, s.kind))
      const outputs = this.workflows.outputs(owner, runId, definition.input.workflowId).map((output) => {
        const { bytes, ...artifact } = output.artifact
        return { observationId: output.observationId, resource: output.resource,
          artifact: { ...artifact, text: researchArtifactText(bytes) } }
      })
      const previews = this.workflowPreviews.listInTransaction(owner, runId)
      const finalStatus = this.finalDecisions.readStatusInTransaction(owner, runId)
      const fullInputVerified = stages.filter(s => s.kind !== 'gemini-research-start')
        .every(s => s.deliveryVerified && !s.blockers.includes('original-input-unlinked'))
      const readyForVerification = stages.every(s => s.blockers.length === 0)
      const state = finalStatus.state === 'needs-input' ? 'needs-input'
        : readyForVerification && finalStatus.state === 'verified-and-synthesized' ? 'verified-and-synthesized' : 'partial'
      this.db.exec('COMMIT')
      return { ownerId: owner, run, definition, stages, outputs, previews, finalStatus, fullInputVerified, readyForVerification, state }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private finalInputs(owner: ResearchOwnerId, runId: ResearchRunId): ResearchFinalInputs {
    const run = this.inspect(owner, runId), inventories: ResearchClaimInventory[] = []
    for (let version = 1; version <= this.latestInventoryVersion(runId); version++) {
      inventories.push(this.readClaimInventory(owner, runId, version))
    }
    const matching = inventories.filter(x => x.input.questionSha256 === run.binding.questionSha256)
    let question: ResearchPreparedPrompt | null = null
    for (const row of this.db.prepare('SELECT input_id FROM research_prepared_prompts WHERE run_id=? ORDER BY prepared_at,input_id').all(runId)) {
      const prepared = this.readPreparedPrompt(owner, runId, text(row, 'input_id') as ResearchPromptInputId)
      if (prepared.questionSha256 === run.binding.questionSha256) { question = prepared; break }
    }
    const map = this.db.prepare('SELECT map_id FROM research_final_maps WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId)
    return {
      run, question, inventories,
      gemini: this.latestReport(owner, runId, 'gemini-report'), chatgpt: this.latestReport(owner, runId, 'chatgpt-report'),
      map: map === undefined ? null : this.finalMaps.read(owner, runId, text(map, 'map_id') as import('@deepseek-ai/dsh-research-handoff/api').ResearchFinalMapId),
      citations: matching.flatMap(x => this.citations.readInventory(owner, runId, x.version)),
      judgments: matching.flatMap(x => this.readClaimJudgments(owner, runId, x.version, 0, Number.MAX_SAFE_INTEGER)),
      source: id => this.sourceReads.read(owner, runId, id),
      dispositions: target => this.dispositions.readTarget(owner, runId, target),
      citation: id => this.citations.read(owner, runId, id),
    }
  }

  /** Close the local database without asserting that external research stopped. */
  close(): void { this.db.close() }

  /**
   * Create an unconfirmed owner-bound run. This grants no execution authority.
   * @param owner - Current trusted Host owner.
   * @param runId - New run identity.
   * @param binding - Exact question, source, mode, destination, and optional plan observations.
   * @returns Initial unconfirmed revision.
   */
  create(owner: ResearchOwnerId, runId: ResearchRunId, binding: ResearchConfirmationBinding): ResearchActionRun {
    this.db.prepare('INSERT INTO research_runs VALUES(?,?,1,?,NULL)').run(runId, owner, bindingJson(binding))
    return this.inspect(owner, runId)
  }

  /**
   * Read run data for its owner; durable confirmation remains data only.
   * @param owner - Current trusted owner.
   * @param runId - Existing run.
   * @returns Current revision and confirmation binding.
   */
  inspect(owner: ResearchOwnerId, runId: ResearchRunId): ResearchActionRun {
    const row = this.db.prepare('SELECT * FROM research_runs WHERE run_id=?').get(runId)
    if (!row) throw new ResearchActionError('research run not found', 'NOT_FOUND')
    if (text(row, 'owner_id') !== owner) throw new ResearchActionError('research run belongs to another owner', 'OWNER')
    const raw = text(row, 'binding_json')
    const revision = row.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      throw new ResearchActionError('invalid durable research revision', 'FORMAT')
    }
    return { runId, revision, binding: parseBinding(raw), bindingSha256: digest(raw), confirmed: row.confirmed_sha256 === digest(raw) }
  }

  /**
   * Replace observations by compare-and-swap, invalidating the prior confirmation.
   * @param owner - Current trusted owner.
   * @param runId - Existing run.
   * @param expectedRevision - Reviewed revision.
   * @param binding - Replacement observations.
   * @returns New unconfirmed revision.
   */
  revise(owner: ResearchOwnerId, runId: ResearchRunId, expectedRevision: number,
    binding: ResearchConfirmationBinding): ResearchActionRun {
    this.inspect(owner, runId)
    const changed = this.db.prepare(`UPDATE research_runs SET revision=revision+1,binding_json=?,confirmed_sha256=NULL
      WHERE run_id=? AND owner_id=? AND revision=?`).run(bindingJson(binding), runId, owner, expectedRevision)
    if (changed.changes !== 1) throw new ResearchActionError('research revision changed', 'REVISION')
    return this.inspect(owner, runId)
  }

  /**
   * Record a trusted confirmation for the exact observed revision and binding.
   * @param owner - Current trusted owner; imported policy is never authority.
   * @param runId - Existing run.
   * @param revision - Reviewed revision.
   * @param bindingSha256 - Reviewed digest.
   * @returns Confirmed data; execution still needs a current Host capability.
   */
  confirm(owner: ResearchOwnerId, runId: ResearchRunId, revision: number, bindingSha256: string): ResearchActionRun {
    const current = this.inspect(owner, runId)
    if (current.revision !== revision || current.bindingSha256 !== bindingSha256) {
      throw new ResearchActionError('confirmation does not match the current research revision', 'CONFIRMATION')
    }
    const changed = this.db.prepare('UPDATE research_runs SET confirmed_sha256=? WHERE run_id=? AND owner_id=? AND revision=?')
      .run(bindingSha256, runId, owner, revision)
    if (changed.changes !== 1) throw new ResearchActionError('research revision changed during confirmation', 'REVISION')
    return this.inspect(owner, runId)
  }

  /**
   * Observe the original action without recreating a page or resubmitting input.
   * @param owner - Current trusted owner.
   * @param runId - Existing run.
   * @param actionId - Original action identity.
   * @returns Exact original input, target, and current independent acceptance state.
   */
  readAction(owner: ResearchOwnerId, runId: ResearchRunId, actionId: ResearchActionId): ResearchActionSnapshot {
    this.inspect(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_actions WHERE run_id=? AND action_id=?').get(runId, actionId)
    if (!row) throw new ResearchActionError('research action not found', 'NOT_FOUND')
    const raw = text(row, 'request_json')
    const state = text(row, 'state')
    if (!['unknown', 'accepted', 'completed', 'not-sent'].includes(state) || digest(raw) !== row.input_sha256) {
      throw new ResearchActionError('invalid durable research action', 'FORMAT')
    }
    if (row.receipt !== null && typeof row.receipt !== 'string') throw new ResearchActionError('invalid research receipt', 'FORMAT')
    const request = parseRequest(raw)
    if (request.runId !== runId || request.actionId !== actionId) {
      throw new ResearchActionError('research action identity changed', 'FORMAT')
    }
    this.assertPreparedPrompt(owner, request)
    const acceptedResource = parseResource(row.accepted_resource_json === null ? null : text(row, 'accepted_resource_json'))
    if (acceptedResource !== null && (acceptedResource.workspace !== request.target.workspace
      || request.target.conversation !== null && acceptedResource.conversation !== request.target.conversation)) {
      throw new ResearchActionError('accepted resource conflicts with original target', 'FORMAT')
    }
    if ((state === 'accepted' || state === 'completed') !== (acceptedResource !== null)) {
      throw new ResearchActionError('durable action state has no matching acceptance resource', 'FORMAT')
    }
    return { request, inputSha256: digest(raw), state: state as ResearchActionState, receipt: row.receipt, acceptedResource }
  }

  /**
   * Retain a complete rendered prompt and owner-readable artifact bytes before any external action.
   * @param owner - Current trusted Host owner.
   * @param runId - Owned run.
   * @param input - Explicit version, original template and every slot value.
   * @returns Immutable exact input; repeated identity with changed content fails.
   */
  preparePrompt(owner: ResearchOwnerId, runId: ResearchRunId, input: ResearchPromptPreparation): ResearchPreparedPrompt {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prepared = this.preparePromptInTransaction(owner, runId, input)
      this.db.exec('COMMIT')
      return prepared
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private resolvePrompt(owner: ResearchOwnerId, runId: ResearchRunId, input: ResearchPromptPreparation,
    preparedAt: string): ResearchPreparedPrompt {
    const run = this.inspect(owner, runId)
    if (run.revision !== input.revision) throw new ResearchActionError('prepared prompt revision changed', 'REVISION')
    const template = readResearchPromptTemplate(input.templateId)
    const values: Record<string, ResearchRetainedPromptPart[]> = {}
    for (const [name, parts] of Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b))) {
      values[name] = parts.map((part) => {
        if (part.kind === 'text') return { kind: 'text', text: part.text }
        const artifact = this.readArtifact(owner, runId, part.artifactId)
        if (artifact.sha256 !== part.sha256) throw new ResearchActionError('prepared prompt artifact changed', 'CONFLICT')
        return { kind: 'artifact', artifactId: artifact.artifactId, version: artifact.version,
          sha256: artifact.sha256, text: researchArtifactText(artifact.bytes) }
      })
    }
    const renderedText = renderResearchPrompt(template, values)
    return parseResearchPreparedPrompt({ inputId: input.inputId, runId, revision: input.revision,
      questionSha256: run.binding.questionSha256, template, values, renderedText, renderedSha256: digest(renderedText), preparedAt })
  }

  private preparePromptInTransaction(owner: ResearchOwnerId, runId: ResearchRunId,
    input: ResearchPromptPreparation): ResearchPreparedPrompt {
    const existing = this.db.prepare('SELECT * FROM research_prepared_prompts WHERE run_id=? AND input_id=?').get(runId, input.inputId)
    const prepared = this.resolvePrompt(owner, runId, input,
      existing === undefined ? new Date().toISOString() : text(existing, 'prepared_at'))
    const raw = JSON.stringify(prepared)
    if (existing !== undefined) {
      this.readPreparedPrompt(owner, runId, input.inputId)
      if (text(existing, 'prepared_json') !== raw) throw new ResearchActionError('immutable prepared input conflicts', 'CONFLICT')
    }
    else this.db.prepare('INSERT INTO research_prepared_prompts VALUES(?,?,?,?,?)')
      .run(runId, input.inputId, prepared.preparedAt, raw, digest(raw))
    return prepared
  }

  /**
   * Read all original prompt and rendered bytes after owner authorization, without renewing confirmation.
   * @param owner - Current trusted owner.
   * @param runId - Owned run.
   * @param inputId - Immutable prepared input.
   * @returns Exact retained input; malformed or mismatched provenance fails.
   */
  readPreparedPrompt(owner: ResearchOwnerId, runId: ResearchRunId, inputId: ResearchPromptInputId): ResearchPreparedPrompt {
    this.inspect(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_prepared_prompts WHERE run_id=? AND input_id=?').get(runId, inputId)
    if (row === undefined) throw new ResearchActionError('prepared research input not found', 'NOT_FOUND')
    const raw = text(row, 'prepared_json')
    const prepared = parseResearchPreparedPrompt(JSON.parse(raw) as unknown)
    if (row.sha256 !== digest(raw) || JSON.stringify(prepared) !== raw || prepared.runId !== runId || prepared.inputId !== inputId
      || prepared.preparedAt !== row.prepared_at) throw new ResearchActionError('invalid durable prepared input', 'FORMAT')
    for (const parts of Object.values(prepared.values)) for (const part of parts) {
      if (part.kind !== 'artifact') continue
      const artifact = this.readArtifact(owner, runId, part.artifactId)
      if (artifact.version !== part.version || artifact.sha256 !== part.sha256 || researchArtifactText(artifact.bytes) !== part.text) {
        throw new ResearchActionError('prepared input artifact provenance conflicts', 'FORMAT')
      }
    }
    return prepared
  }

  private assertPreparedPrompt(owner: ResearchOwnerId, request: ResearchActionRequest): void {
    if (request.preparedPromptId === null) return
    const prepared = this.readPreparedPrompt(owner, request.runId, request.preparedPromptId)
    const kind = prepared.template.id === 'gemini-deep-research' ? 'gemini-plan-submit' : 'chatgpt-submit'
    if (prepared.revision !== request.revision || prepared.questionSha256 !== request.binding.questionSha256
      || prepared.renderedText !== request.input || request.kind !== kind) {
      throw new ResearchActionError('action does not match its prepared input', 'CONFLICT')
    }
  }

  /**
   * Retain the first actual qualification after its original unknown action exists.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param actionId - Original action.
   * @param requestSha256 - Complete original request digest.
   * @param value - Actual Driver qualification; no default observation is synthesized.
   * @returns Immutable recorded observation with local receipt time.
   */
  recordQualification(owner: ResearchOwnerId, runId: ResearchRunId, actionId: ResearchActionId,
    requestSha256: string, value: ResearchDriverQualification): ResearchQualificationRecord {
    const observation = parseResearchQualification(value)
    const raw = JSON.stringify(observation)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const action = this.readAction(owner, runId, actionId)
      if (action.inputSha256 !== requestSha256) throw new ResearchActionError('qualification request conflicts', 'CONFLICT')
      const existing = this.readQualification(owner, runId, actionId)
      if (existing !== null) {
        if (JSON.stringify(existing.observation) !== raw) throw new ResearchActionError('immutable qualification conflicts', 'CONFLICT')
      }
      else {
        this.db.prepare('INSERT INTO research_driver_qualifications VALUES(?,?,?,?,?,?)')
          .run(runId, actionId, requestSha256, new Date().toISOString(), raw, digest(raw))
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const recorded = this.readQualification(owner, runId, actionId)
    if (recorded === null) throw new ResearchActionError('qualification record disappeared', 'FORMAT')
    return recorded
  }

  /**
   * Read the actual retained qualification without invoking a Driver or renewing authority.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param actionId - Original action.
   * @returns Recorded observation, or null if no result was observed.
   */
  readQualification(owner: ResearchOwnerId, runId: ResearchRunId, actionId: ResearchActionId): ResearchQualificationRecord | null {
    const action = this.readAction(owner, runId, actionId)
    const row = this.db.prepare('SELECT * FROM research_driver_qualifications WHERE run_id=? AND action_id=?').get(runId, actionId)
    if (row === undefined) return null
    const raw = text(row, 'qualification_json')
    const observation = parseResearchQualification(JSON.parse(raw) as unknown)
    const recordedAt = text(row, 'recorded_at')
    if (row.request_sha256 !== action.inputSha256 || row.sha256 !== digest(raw)
      || JSON.stringify(observation) !== raw || !Number.isFinite(Date.parse(recordedAt))
      || new Date(recordedAt).toISOString() !== recordedAt) {
      throw new ResearchActionError('invalid durable qualification', 'FORMAT')
    }
    return { runId, actionId, requestSha256: action.inputSha256, recordedAt, observation, sha256: digest(raw) }
  }

  /**
   * Persist unknown before invoking an admitted effect once. Existing actions are observation-only.
   * @param owner - Current trusted owner; the enclosing Provider must also check its current Host capability.
   * @param request - Immutable action, original target, and Provider-derived logical step; UI attempt IDs are not step IDs.
   * @param invoke - Already-authorized Driver effect receiving the recorded request; throws preserve unknown.
   * @returns Original or newly observed action, never a fabricated successful result.
   */
  async execute(owner: ResearchOwnerId, request: ResearchActionRequest,
    invoke: (recorded: ResearchActionRequest) => Promise<ResearchActionObservation>): Promise<ResearchActionSnapshot> {
    const raw = requestJson(request)
    const original = parseRequest(raw)
    let fresh = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.inspect(owner, original.runId)
      const existing = this.db.prepare('SELECT request_json FROM research_actions WHERE run_id=? AND action_id=?')
        .get(original.runId, original.actionId)
      if (existing) {
        if (existing.request_json !== raw) throw new ResearchActionError('research action input or target conflicts', 'CONFLICT')
      }
      else {
        if (run.revision !== original.revision || run.bindingSha256 !== original.bindingSha256 || !run.confirmed) {
          throw new ResearchActionError('research action has no current exact confirmation', 'CONFIRMATION')
        }
        this.assertPreparedPrompt(owner, original)
        const held = this.db.prepare("SELECT action_id FROM research_actions WHERE run_id=? AND state IN ('unknown','accepted')")
          .get(original.runId)
        if (held) throw new ResearchActionError('an original research action is still unresolved', 'PENDING')
        const sameStep = this.db.prepare('SELECT action_id FROM research_actions WHERE run_id=? AND revision=? AND step_id=?')
          .get(original.runId, original.revision, original.stepId)
        if (sameStep) throw new ResearchActionError('the research step already has an original action', 'CONFLICT')
        this.db.prepare("INSERT INTO research_actions VALUES(?,?,?,?,?,?,'unknown',NULL,NULL)")
          .run(original.runId, original.actionId, original.revision, original.stepId, raw, digest(raw))
        fresh = true
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (fresh) {
      const observed = await invoke(original)
      this.recordObservation(owner, original.runId, original.actionId, digest(raw), observed)
    }
    return this.readAction(owner, original.runId, original.actionId)
  }

  /**
   * Atomically append an observation and update its action; terminal receipts cannot be replaced.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param actionId - Original action.
   * @param inputSha256 - Original request digest, never a model-provided authorization claim.
   * @param observation - Actual Driver observation; cancellation needs separate remote proof.
   * @returns Updated durable action.
   */
  recordObservation(owner: ResearchOwnerId, runId: ResearchRunId, actionId: ResearchActionId,
    inputSha256: string, observation: ResearchActionObservation): ResearchActionSnapshot {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readAction(owner, runId, actionId)
      if (current.inputSha256 !== inputSha256) throw new ResearchActionError('research observation input conflicts', 'CONFLICT')
      const resource = parseResource(resourceJson(observation.acceptedResource))
      if (resource !== null && (observation.state === 'not-sent'
        || resource.workspace !== current.request.target.workspace
        || current.request.target.conversation !== null && resource.conversation !== current.request.target.conversation
        || current.acceptedResource !== null && (current.acceptedResource.page !== resource.page
          || current.acceptedResource.conversation !== null && current.acceptedResource.conversation !== resource.conversation
          || current.acceptedResource.report !== null && current.acceptedResource.report !== resource.report))) {
        throw new ResearchActionError('research acceptance resource conflicts', 'CONFLICT')
      }
      const acceptedResource = resource ?? current.acceptedResource
      if ((observation.state === 'accepted' || observation.state === 'completed') && acceptedResource === null) {
        throw new ResearchActionError('research acceptance resource is missing', 'CONFLICT')
      }
      if (current.state === observation.state && current.receipt === observation.receipt
        && resourceJson(current.acceptedResource) === resourceJson(acceptedResource)) {
        this.db.exec('COMMIT')
        return current
      }
      if (current.state === 'completed' || current.state === 'not-sent'
        || current.state === 'accepted' && observation.state === 'not-sent') {
        throw new ResearchActionError('research observation contradicts prior acceptance or termination', 'CONFLICT')
      }
      this.db.prepare('INSERT INTO research_action_observations(run_id,action_id,state,receipt,accepted_resource_json) VALUES(?,?,?,?,?)')
        .run(runId, actionId, observation.state, observation.receipt, resourceJson(acceptedResource))
      this.db.prepare('UPDATE research_actions SET state=?,receipt=?,accepted_resource_json=? WHERE run_id=? AND action_id=? AND input_sha256=?')
        .run(observation.state, observation.receipt, resourceJson(acceptedResource), runId, actionId, inputSha256)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.readAction(owner, runId, actionId)
  }

  /**
   * Read stable observation IDs for an owner-scoped, reconstructable Session/UI projection.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param afterSeq - Exclusive durable sequence position.
   * @param limit - Explicit positive maximum number of records.
   * @returns Append-only observations in sequence order; this is not an execution permission source.
   */
  readObservations(owner: ResearchOwnerId, runId: ResearchRunId, afterSeq: number, limit: number): ResearchObservationRecord[] {
    this.inspect(owner, runId)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ResearchActionError('invalid research observation range', 'FORMAT')
    }
    const rows = this.db.prepare(`SELECT * FROM research_action_observations
      WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?`).all(runId, afterSeq, limit)
    return rows.map((row) => {
      const state = text(row, 'state')
      if (!['accepted', 'completed', 'not-sent'].includes(state) || typeof row.seq !== 'number') {
        throw new ResearchActionError('invalid durable research observation', 'FORMAT')
      }
      const acceptedResource = parseResource(row.accepted_resource_json === null ? null : text(row, 'accepted_resource_json'))
      if ((state === 'accepted' || state === 'completed') !== (acceptedResource !== null)) {
        throw new ResearchActionError('durable observation has no matching acceptance resource', 'FORMAT')
      }
      return {
        seq: row.seq, runId, actionId: text(row, 'action_id') as ResearchActionId,
        state: state as ResearchActionObservation['state'], receipt: text(row, 'receipt'), acceptedResource,
      }
    })
  }

  /**
   * Append exact UTF-8 capture bytes in the run database; earlier versions are never overwritten.
   * @param owner - Current trusted owner; hashes do not grant access.
   * @param runId - Original run.
   * @param input - Original action association, capture observation, and last observed role version.
   * @returns New or identical original artifact; capture extent does not establish process or verification completion.
   */
  captureArtifact(owner: ResearchOwnerId, runId: ResearchRunId, input: ResearchArtifactInput): ResearchArtifactSnapshot {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const artifact = this.captureArtifactInTransaction(owner, runId, input)
      this.db.exec('COMMIT')
      return artifact
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** The caller owns the enclosing SQLite transaction, including any workflow observation association. */
  private captureArtifactInTransaction(owner: ResearchOwnerId, runId: ResearchRunId,
    input: ResearchArtifactInput): ResearchArtifactSnapshot {
    const bytes = Uint8Array.from(input.bytes)
    researchArtifactText(bytes)
    const source = parseResearchCapture(input.source)
    const sourceJson = JSON.stringify({
      page: source.page, conversation: source.conversation, method: source.method,
      capturedAt: source.capturedAt, extent: source.extent, endEvidence: source.endEvidence,
    })
    const action = this.readAction(owner, runId, input.actionId)
    const captureTarget = action.acceptedResource ?? action.request.target
    if (captureTarget.page !== source.page
      || captureTarget.conversation !== null && captureTarget.conversation !== source.conversation) {
      throw new ResearchActionError('capture does not match the original action target', 'CONFLICT')
    }
    const existing = this.db.prepare('SELECT * FROM research_artifacts WHERE run_id=? AND artifact_id=?').get(runId, input.artifactId)
    if (existing) {
      if (existing.action_id !== input.actionId || existing.request_sha256 !== action.inputSha256
        || existing.role !== input.role || existing.version !== input.expectedVersion + 1
        || existing.source_json !== sourceJson || existing.sha256 !== researchArtifactHash(bytes)) {
        throw new ResearchActionError('immutable research artifact conflicts', 'CONFLICT')
      }
    }
    else {
      const latest = this.db.prepare('SELECT MAX(version) AS version FROM research_artifacts WHERE run_id=? AND role=?').get(runId, input.role)
      if ((latest?.version ?? 0) !== input.expectedVersion) throw new ResearchActionError('research artifact version changed', 'REVISION')
      this.db.prepare('INSERT INTO research_artifacts VALUES(?,?,?,?,?,?,?,?,?)').run(
        runId, input.artifactId, input.actionId, action.inputSha256, input.role, input.expectedVersion + 1,
        sourceJson, bytes, researchArtifactHash(bytes),
      )
    }
    return this.readArtifact(owner, runId, input.artifactId)
  }

  /**
   * Read complete retained bytes after checking run ownership and durable integrity.
   * @param owner - Current trusted owner; knowing artifact ID or digest is insufficient.
   * @param runId - Original run.
   * @param artifactId - Immutable capture identity.
   * @returns Independent capture extent, original action digest, and all original bytes.
   */
  readArtifact(owner: ResearchOwnerId, runId: ResearchRunId, artifactId: ResearchArtifactId): ResearchArtifactSnapshot {
    this.inspect(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_artifacts WHERE run_id=? AND artifact_id=?').get(runId, artifactId)
    if (!row) throw new ResearchActionError('research artifact not found', 'NOT_FOUND')
    if (!(row.bytes instanceof Uint8Array) || researchArtifactHash(row.bytes) !== row.sha256
      || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
      || !['gemini-plan', 'gemini-report', 'chatgpt-report', 'verification'].includes(text(row, 'role'))) {
      throw new ResearchActionError('invalid durable research artifact', 'FORMAT')
    }
    researchArtifactText(row.bytes)
    const source = parseResearchCapture(JSON.parse(text(row, 'source_json')) as unknown)
    const actionId = text(row, 'action_id') as ResearchActionId
    const action = this.readAction(owner, runId, actionId)
    const captureTarget = action.acceptedResource ?? action.request.target
    if (action.inputSha256 !== row.request_sha256 || captureTarget.page !== source.page
      || captureTarget.conversation !== null && captureTarget.conversation !== source.conversation) {
      throw new ResearchActionError('durable capture action association changed', 'FORMAT')
    }
    return {
      runId, artifactId, actionId, requestSha256: text(row, 'request_sha256'),
      role: text(row, 'role') as ResearchArtifactInput['role'], version: row.version,
      source, bytes: Uint8Array.from(row.bytes), sha256: text(row, 'sha256'),
    }
  }

  private latestReport(owner: ResearchOwnerId, run: ResearchRunId, role: 'gemini-report' | 'chatgpt-report'): ResearchArtifactSnapshot | null {
    this.inspect(owner, run)
    const row = this.db.prepare('SELECT artifact_id FROM research_artifacts WHERE run_id=? AND role=? ORDER BY version DESC LIMIT 1').get(run, role)
    return row === undefined ? null : this.readArtifact(owner, run, text(row, 'artifact_id') as ResearchArtifactId)
  }

  private readCounterJudgment(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchJudgmentId): ResearchClaimJudgment {
    this.inspect(owner, run)
    const row = this.db.prepare('SELECT seq,inventory_version FROM research_claim_judgments WHERE run_id=? AND judgment_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('counter judgment not found', 'NOT_FOUND')
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1
      || typeof row.inventory_version !== 'number' || !Number.isSafeInteger(row.inventory_version) || row.inventory_version < 1) {
      throw new ResearchActionError('invalid counter judgment reference', 'FORMAT')
    }
    const judgment = this.readClaimJudgments(owner, run, row.inventory_version, row.seq - 1, 1)[0]
    if (judgment?.judgmentId !== id) throw new ResearchActionError('counter judgment identity changed', 'FORMAT')
    return judgment
  }

  private latestInventoryVersion(runId: ResearchRunId): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM research_claim_inventories WHERE run_id=?').get(runId)
    const value = row?.version ?? 0
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ResearchActionError('invalid durable inventory version', 'FORMAT')
    }
    return value
  }

  private inventorySourcesCurrent(owner: ResearchOwnerId, runId: ResearchRunId, input: ResearchClaimInventoryInput): boolean {
    for (const role of ['gemini-report', 'chatgpt-report']) {
      const row = this.db.prepare('SELECT artifact_id FROM research_artifacts WHERE run_id=? AND role=? ORDER BY version DESC LIMIT 1')
        .get(runId, role)
      if (!row) return false
      const artifact = this.readArtifact(owner, runId, text(row, 'artifact_id') as ResearchArtifactId)
      if (artifact.source.extent !== 'complete'
        || !input.materials.some(x => x.artifactId === artifact.artifactId && x.sha256 === artifact.sha256)) return false
    }
    return true
  }

  /**
   * Append candidate claims and explicit derivations in the same owner database.
   * @param owner - Current trusted owner; imported content cannot confirm itself.
   * @param runId - Original run.
   * @param value - Imported candidates; every material digest is checked against an owned immutable capture.
   * @returns Unconfirmed new inventory. This records provenance, not factual source support.
   */
  appendClaimInventory(owner: ResearchOwnerId, runId: ResearchRunId, value: unknown): ResearchClaimInventory {
    const input = parseResearchClaimInventory(value)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.inspect(owner, runId)
      const previousVersion = this.latestInventoryVersion(runId)
      if (previousVersion !== input.expectedVersion) throw new ResearchActionError('claim inventory version changed', 'REVISION')
      if (input.questionSha256 !== run.binding.questionSha256) throw new ResearchActionError('claim question binding changed', 'CONFLICT')
      const previous = previousVersion === 0 ? null : this.readClaimInventory(owner, runId, previousVersion).input
      validateResearchClaimChanges(previous, input)
      const materials = new Map(input.materials.map(material => [
        material.artifactId, this.readArtifact(owner, runId, material.artifactId),
      ]))
      for (const material of input.materials) {
        if (materials.get(material.artifactId)?.sha256 !== material.sha256) {
          throw new ResearchActionError('claim inventory material digest conflicts', 'CONFLICT')
        }
      }
      for (const claim of input.claims) {
        for (const origin of claim.origins) {
          if (origin.kind === 'question') {
            if (origin.sha256 !== input.questionSha256) throw new ResearchActionError('claim question origin conflicts', 'CONFLICT')
          }
          else {
            const artifact = origin.artifactId === null ? undefined : materials.get(origin.artifactId)
            const role = origin.kind === 'gemini-report' ? 'gemini-report' : 'chatgpt-report'
            if (!artifact || artifact.sha256 !== origin.sha256 || artifact.role !== role) {
              throw new ResearchActionError('claim report origin is not an owned bound material', 'CONFLICT')
            }
          }
        }
      }
      const raw = JSON.stringify({ runRevision: run.revision, input })
      this.db.prepare('INSERT INTO research_claim_inventories VALUES(?,?,?,?,?,NULL)')
        .run(runId, previousVersion + 1, run.revision, raw, digest(raw))
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.readClaimInventory(owner, runId, input.expectedVersion + 1)
  }

  /**
   * Read a pinned inventory without applying a historical confirmation to newer reports or revisions.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param version - Exact retained inventory version.
   * @returns Historical candidates and current denominator confirmation data; neither establishes verified coverage.
   */
  readClaimInventory(owner: ResearchOwnerId, runId: ResearchRunId, version: number): ResearchClaimInventory {
    const run = this.inspect(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_claim_inventories WHERE run_id=? AND version=?').get(runId, version)
    if (!row) throw new ResearchActionError('claim inventory not found', 'NOT_FOUND')
    const raw = text(row, 'inventory_json')
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value) || digest(raw) !== row.sha256
      || typeof row.run_revision !== 'number' || !Number.isSafeInteger(row.run_revision) || row.run_revision < 1) {
      throw new ResearchActionError('invalid durable claim inventory', 'FORMAT')
    }
    const record = value as Record<string, unknown>
    const input = parseResearchClaimInventory(record.input)
    if (record.runRevision !== row.run_revision || input.expectedVersion + 1 !== version) {
      throw new ResearchActionError('durable claim inventory revision conflicts', 'FORMAT')
    }
    const isCurrent = this.latestInventoryVersion(runId) === version && run.revision === row.run_revision
    return {
      version, runRevision: row.run_revision, input, sha256: digest(raw), isCurrent,
      recordedConfirmation: row.confirmed_sha256 === digest(raw),
      denominatorConfirmed: isCurrent && row.confirmed_sha256 === digest(raw) && this.inventorySourcesCurrent(owner, runId, input),
    }
  }

  /**
   * Record a trusted control's exact candidate-denominator confirmation, independently of judgments.
   * @param owner - Current trusted owner; the enclosing Provider must authorize this control call.
   * @param runId - Original run.
   * @param version - Current candidate version.
   * @param sha256 - Exact reviewed inventory digest.
   * @returns Confirmation data, never execution permission or completed factual verification.
   */
  confirmClaimInventory(owner: ResearchOwnerId, runId: ResearchRunId, version: number, sha256: string): ResearchClaimInventory {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inventory = this.readClaimInventory(owner, runId, version)
      if (!inventory.isCurrent || inventory.sha256 !== sha256 || !this.inventorySourcesCurrent(owner, runId, inventory.input)) {
        throw new ResearchActionError('inventory confirmation requires the exact current two-stage materials', 'CONFIRMATION')
      }
      this.db.prepare('UPDATE research_claim_inventories SET confirmed_sha256=? WHERE run_id=? AND version=? AND sha256=?')
        .run(sha256, runId, version, sha256)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.readClaimInventory(owner, runId, version)
  }

  /**
   * Append an attributed material interpretation without inventing actual source-read evidence.
   * @param owner - Current trusted owner; the Provider supplies attribution from its actual input channel.
   * @param runId - Original run.
   * @param value - Candidate-specific judgment data; supplied completion or coverage fields are excluded.
   * @param attribution - Current Host input-channel assertion, separate from all imported judgment fields.
   * @returns Stable append-only judgment; supported remains an interpretation, not verification.
   */
  appendClaimJudgment(owner: ResearchOwnerId, runId: ResearchRunId, value: unknown,
    attribution: ResearchJudgmentAttribution): ResearchClaimJudgment {
    const judgment = parseResearchClaimJudgment(value)
    const channel = parseResearchJudgmentAttribution(attribution)
    if (channel.ownerId !== owner) throw new ResearchActionError('judgment attribution owner conflicts', 'OWNER')
    const raw = JSON.stringify(judgment)
    const channelRaw = JSON.stringify(channel)
    this.db.exec('BEGIN IMMEDIATE')
    let seq: number
    try {
      const inventory = this.readClaimInventory(owner, runId, judgment.inventoryVersion)
      if (!inventory.input.claims.some(x => x.id === judgment.claimId)) {
        throw new ResearchActionError('judgment claim is absent from its inventory', 'CONFLICT')
      }
      for (const artifactId of judgment.materialArtifactIds) this.readArtifact(owner, runId, artifactId)
      const existing = this.db.prepare('SELECT * FROM research_claim_judgments WHERE run_id=? AND judgment_id=?')
        .get(runId, judgment.judgmentId)
      if (existing) {
        if (existing.judgment_json !== raw || existing.sha256 !== digest(raw) || typeof existing.seq !== 'number'
          || existing.attribution_json !== channelRaw || existing.attribution_sha256 !== digest(channelRaw)) {
          throw new ResearchActionError('immutable claim judgment conflicts', 'CONFLICT')
        }
        seq = existing.seq
      }
      else {
        const result = this.db.prepare(`INSERT INTO research_claim_judgments
          (run_id,judgment_id,inventory_version,claim_id,judgment_json,sha256,attribution_json,attribution_sha256) VALUES(?,?,?,?,?,?,?,?)`)
          .run(runId, judgment.judgmentId, judgment.inventoryVersion, judgment.claimId, raw, digest(raw), channelRaw, digest(channelRaw))
        seq = Number(result.lastInsertRowid)
      }
      if (!Number.isSafeInteger(seq) || seq < 1) throw new ResearchActionError('invalid durable judgment sequence', 'FORMAT')
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { ...judgment, seq, attribution: channel }
  }

  /**
   * Read retained interpretations without converting their supported labels into verified coverage.
   * @param owner - Current trusted owner.
   * @param runId - Original run.
   * @param inventoryVersion - Exact candidate version.
   * @param afterSeq - Exclusive durable judgment position.
   * @param limit - Explicit positive page size.
   * @returns Ordered attributed judgments for a reconstructable projection.
   */
  readClaimJudgments(owner: ResearchOwnerId, runId: ResearchRunId, inventoryVersion: number,
    afterSeq: number, limit: number): ResearchClaimJudgment[] {
    this.readClaimInventory(owner, runId, inventoryVersion)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ResearchActionError('invalid claim judgment range', 'FORMAT')
    }
    return this.db.prepare(`SELECT * FROM research_claim_judgments
      WHERE run_id=? AND inventory_version=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(runId, inventoryVersion, afterSeq, limit).map((row) => {
        const raw = text(row, 'judgment_json')
        const judgment = parseResearchClaimJudgment(JSON.parse(raw) as unknown)
        const attributionRaw = text(row, 'attribution_json')
        const attribution = parseResearchJudgmentAttribution(JSON.parse(attributionRaw) as unknown)
        if (digest(attributionRaw) !== row.attribution_sha256 || attribution.ownerId !== owner
          || digest(raw) !== row.sha256 || judgment.inventoryVersion !== inventoryVersion
          || judgment.judgmentId !== row.judgment_id || judgment.claimId !== row.claim_id
          || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1) {
          throw new ResearchActionError('invalid durable claim judgment', 'FORMAT')
        }
        return { ...judgment, seq: row.seq, attribution }
      })
  }
}
