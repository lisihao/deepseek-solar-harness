import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  applyGovernanceEvent,
  emptyGovernanceState,
  foldGovernance,
  isGovernanceEvent,
} from './state.js'
import {
  gitMetadataPath,
  runGovernance,
  runGovernanceSync,
  sha256,
  sha256File,
} from './runner.js'

const DEFAULT_CORE = fileURLToPath(new URL('../runtime/governance.py', import.meta.url))
const LEVELS = new Set(['quick', 'full'])

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`${label} must be an array of non-empty strings`)
  }
  return [...value]
}

export function resolveConfig(config = {}) {
  const known = new Set([
    'python', 'corePath', 'profilePath', 'strict', 'timeoutMs', 'syncTimeoutMs',
    'maxOutputBytes', 'maxContinuationRejections', 'mutationToolNames',
    'maxTraceEvents',
    'commitCommandPatterns', 'deliveryCommandPatterns', 'mutationCommandPatterns',
  ])
  const unknown = Object.keys(config).filter(key => !known.has(key))
  if (unknown.length > 0) throw new TypeError(`unknown governance config key(s): ${unknown.join(', ')}`)
  const result = {
    python: config.python ?? 'python3',
    corePath: config.corePath ?? DEFAULT_CORE,
    profilePath: config.profilePath ?? null,
    strict: config.strict ?? true,
    timeoutMs: config.timeoutMs ?? 1_800_000,
    syncTimeoutMs: config.syncTimeoutMs ?? 30_000,
    maxOutputBytes: config.maxOutputBytes ?? 4 * 1024 * 1024,
    maxContinuationRejections: config.maxContinuationRejections ?? 3,
    maxTraceEvents: config.maxTraceEvents ?? 200,
    mutationToolNames: config.mutationToolNames ?? [
      'apply_patch', 'str_replace_editor', 'write_file', 'edit_file', 'notebook_edit',
    ],
    commitCommandPatterns: config.commitCommandPatterns ?? [
      '(^|[;&|]\\s*)git\\s+(?:-[^ ]+\\s+)*commit\\b',
    ],
    deliveryCommandPatterns: config.deliveryCommandPatterns ?? [
      '(^|[;&|]\\s*)git\\s+(?:-[^ ]+\\s+)*push\\b',
      '(^|[;&|]\\s*)gh\\s+pr\\s+(?:merge|create)\\b',
      '(^|[;&|]\\s*)(?:npm|pnpm|yarn)\\s+(?:publish|deploy)\\b',
      '(^|[;&|]\\s*)docker\\s+(?:push|stack\\s+deploy)\\b',
    ],
    mutationCommandPatterns: config.mutationCommandPatterns ?? [
      '(^|[;&|]\\s*)git\\s+(?:-[^ ]+\\s+)*(?:add|commit|merge|rebase|reset|restore|checkout|switch|clean|mv|rm)\\b',
      '(^|[;&|]\\s*)(?:rm|mv|cp|install|mkdir|touch|truncate)\\b',
    ],
  }
  if (typeof result.python !== 'string' || result.python === '') throw new TypeError('python must be a non-empty string')
  if (typeof result.corePath !== 'string' || result.corePath === '') throw new TypeError('corePath must be a non-empty string')
  if (result.profilePath !== null && (typeof result.profilePath !== 'string' || result.profilePath === '')) {
    throw new TypeError('profilePath must be null or a non-empty string')
  }
  if (typeof result.strict !== 'boolean') throw new TypeError('strict must be boolean')
  positiveInteger(result.timeoutMs, 'timeoutMs')
  positiveInteger(result.syncTimeoutMs, 'syncTimeoutMs')
  positiveInteger(result.maxOutputBytes, 'maxOutputBytes')
  positiveInteger(result.maxContinuationRejections, 'maxContinuationRejections')
  positiveInteger(result.maxTraceEvents, 'maxTraceEvents')
  result.mutationToolNames = stringArray(result.mutationToolNames, 'mutationToolNames')
  result.commitCommandPatterns = stringArray(result.commitCommandPatterns, 'commitCommandPatterns')
  result.deliveryCommandPatterns = stringArray(result.deliveryCommandPatterns, 'deliveryCommandPatterns')
  result.mutationCommandPatterns = stringArray(result.mutationCommandPatterns, 'mutationCommandPatterns')
  result.compiledCommitPatterns = result.commitCommandPatterns.map(pattern => new RegExp(pattern, 'u'))
  result.compiledDeliveryPatterns = result.deliveryCommandPatterns.map(pattern => new RegExp(pattern, 'u'))
  result.compiledMutationPatterns = result.mutationCommandPatterns.map(pattern => new RegExp(pattern, 'u'))
  return result
}

function now() {
  return new Date().toISOString()
}

function projectFor(agent) {
  const project = agent?.session?.header?.cwd
  if (typeof project !== 'string' || project === '') {
    throw new Error('governance requires an agent session with an absolute cwd')
  }
  return project
}

function hasGitBoundary(project) {
  let current = project
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function append(agent, type, data) {
  return agent.session.append(type, data, { ignorable: true })
}

function normalizeLevel(level) {
  const selected = level ?? 'full'
  if (!LEVELS.has(selected)) throw new TypeError('level must be quick or full')
  return selected
}

function normalizeScope(scope) {
  const selected = scope ?? 'auto'
  if (typeof selected !== 'string' || selected.trim() === '') throw new TypeError('scope must be a non-empty string')
  return selected
}

function outputTail(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string').slice(-40)
}

function redactOutput(value) {
  return value
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/gu, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/gu, '[REDACTED_HF_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gu, '$1=[REDACTED]')
}

const TRACE_TIMESTAMP_FIELDS = Object.freeze([
  'openedAt', 'recordedAt', 'startedAt', 'finishedAt', 'issuedAt',
  'requestedAt', 'rejectedAt', 'acceptedAt', 'invalidatedAt', 'evaluatedAt',
])

const TRACE_DATA_FIELDS = Object.freeze([
  'workId', 'runId', 'gateId', 'status', 'level', 'scope', 'gitHead',
  'profileSha256', 'changeFingerprint', 'attestationSha256', 'outputSha256',
  'logPath', 'reportPath', 'reasonCode', 'message', 'kind', 'decision',
  'toolName', 'commandSha256',
])

function traceTimestamp(data) {
  for (const field of TRACE_TIMESTAMP_FIELDS) {
    if (typeof data[field] === 'string') return data[field]
  }
  return null
}

function traceData(data) {
  const result = {}
  for (const field of TRACE_DATA_FIELDS) {
    if (data[field] !== undefined) result[field] = data[field]
  }
  return result
}

export class GovernanceService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = resolveConfig(config)
  }

  state(agent) {
    return foldGovernance(agent.session.events)
  }

  applies(agent) {
    try {
      return hasGitBoundary(projectFor(agent))
    } catch {
      return false
    }
  }

  trace(agent, requestedLimit) {
    this.ensureWork(agent)
    return this.traceSession(agent.session, requestedLimit)
  }

  traceSession(session, requestedLimit) {
    const limit = requestedLimit ?? this.config.maxTraceEvents
    positiveInteger(limit, 'trace limit')
    if (limit > this.config.maxTraceEvents) {
      throw new RangeError(`trace limit cannot exceed ${String(this.config.maxTraceEvents)}`)
    }
    let governanceState = emptyGovernanceState()
    const events = []
    for (const [sequence, event] of session.events.entries()) {
      if (!isGovernanceEvent(event)) continue
      governanceState = applyGovernanceEvent(governanceState, event)
      events.push({
        sequence,
        type: event.type,
        timestamp: traceTimestamp(event.data),
        phaseAfter: governanceState.phase,
        ...traceData(event.data),
      })
    }
    return {
      phase: governanceState.phase,
      workId: governanceState.workId,
      totalEvents: events.length,
      returnedEvents: Math.min(events.length, limit),
      events: events.slice(-limit),
    }
  }

  ensureWork(agent, forceNew = false) {
    const state = this.state(agent)
    if (!this.applies(agent)) return state
    if (!forceNew && state.phase !== 'unmanaged') return state
    if (!['unmanaged', 'accepted', 'blocked'].includes(state.phase)) return state
    append(agent, 'governance/work-opened', {
      workId: randomUUID(),
      project: projectFor(agent),
      openedAt: now(),
    })
    return this.state(agent)
  }

  async audit(agent) {
    const project = projectFor(agent)
    const result = await runGovernance(
      this.config,
      'audit',
      project,
      this.config.strict ? ['--strict-warnings'] : [],
    )
    return {
      ok: result.code === 0 && result.payload !== null,
      code: result.code,
      outputSha256: result.outputSha256,
      payload: result.payload,
    }
  }

  async plan(agent, options = {}) {
    let state = this.ensureWork(agent, options.forceNew === true)
    const level = normalizeLevel(options.level)
    const scope = normalizeScope(options.scope)
    const project = projectFor(agent)
    const extra = ['--scope', scope, '--level', level]
    if (typeof options.changedFrom === 'string' && options.changedFrom !== '') {
      extra.push('--changed-from', options.changedFrom)
    }
    const audit = await this.audit(agent)
    if (!audit.ok) throw new Error(`governance audit failed with exit ${String(audit.code)}`)
    const result = await runGovernance(this.config, 'plan', project, extra)
    if (result.code !== 0 || result.payload === null) {
      throw new Error(`governance plan failed with exit ${String(result.code)}`)
    }
    const gates = Array.isArray(result.payload.gates) ? result.payload.gates : []
    const changedFiles = Array.isArray(result.payload.changed_files) ? result.payload.changed_files : []
    append(agent, 'governance/plan-recorded', {
      workId: state.workId,
      level,
      scope,
      gates,
      changedFilesSha256: sha256(JSON.stringify(changedFiles)),
      auditSha256: audit.outputSha256,
      recordedAt: now(),
    })
    return { audit: audit.payload, plan: result.payload, state: this.publicState(agent) }
  }

  async writeRunLog(project, runId, result) {
    const reportPath = await gitMetadataPath(project)
    const directory = join(dirname(reportPath), 'governance', 'runs')
    await mkdir(directory, { recursive: true })
    const logPath = join(directory, `${runId}.log`)
    const content = redactOutput(
      `argv=${JSON.stringify(result.argv)}\nexit=${String(result.code)} signal=${String(result.signal)} timedOut=${String(result.timedOut)} overflow=${String(result.overflow)}\n\n[stdout]\n${result.stdout}\n\n[stderr]\n${result.stderr}`,
    )
    await writeFile(logPath, content, { encoding: 'utf8', mode: 0o600 })
    return { logPath, logSha256: sha256(content), reportPath }
  }

  async verify(agent, options = {}) {
    const level = normalizeLevel(options.level)
    const scope = normalizeScope(options.scope)
    const planned = await this.plan(agent, options)
    const state = this.state(agent)
    const project = projectFor(agent)
    const runId = randomUUID()
    const extra = ['--scope', scope, '--level', level, '--report', '@git']
    if (typeof options.changedFrom === 'string' && options.changedFrom !== '') {
      extra.push('--changed-from', options.changedFrom)
    }
    append(agent, 'governance/run-started', {
      workId: state.workId,
      runId,
      level,
      scope,
      changedFrom: options.changedFrom ?? null,
      startedAt: now(),
    })
    const result = await runGovernance(this.config, 'verify', project, extra)
    const artifact = await this.writeRunLog(project, runId, result)
    const items = Array.isArray(result.payload?.items) ? result.payload.items : []
    for (const item of items) {
      append(agent, 'governance/gate-finished', {
        workId: state.workId,
        runId,
        gateId: String(item.id ?? 'unknown'),
        status: item.status === 'ok' ? 'ok' : 'error',
        returncode: item.returncode ?? null,
        durationSeconds: item.duration_seconds ?? null,
        outputSha256: typeof item.output_sha256 === 'string' ? item.output_sha256 : result.outputSha256,
        outputTail: outputTail(item.output_tail),
        logPath: artifact.logPath,
        logSha256: artifact.logSha256,
        finishedAt: now(),
      })
    }
    if (result.code !== 0 || result.payload === null || items.length === 0 || items.some(item => item.status !== 'ok')) {
      append(agent, 'governance/completion-rejected', {
        workId: state.workId,
        reasonCode: result.timedOut ? 'timed-out' : 'failed-gate',
        message: `verification run ${runId} did not pass every selected gate`,
        terminal: false,
        rejectedAt: now(),
      })
      await this.ctx.sessions.flush(agent.session)
      return { ok: false, runId, result: result.payload, state: this.publicState(agent) }
    }
    const attest = await runGovernance(
      this.config,
      'attest',
      project,
      ['--report', '@git', '--require-level', level],
    )
    if (attest.code !== 0 || attest.payload === null) {
      append(agent, 'governance/completion-rejected', {
        workId: state.workId,
        reasonCode: 'evidence-corrupt',
        message: 'verification output could not be re-attested',
        terminal: false,
        rejectedAt: now(),
      })
      await this.ctx.sessions.flush(agent.session)
      return { ok: false, runId, result: result.payload, attestation: attest.payload, state: this.publicState(agent) }
    }
    const report = JSON.parse(await readFile(artifact.reportPath, 'utf8'))
    const attestationSha256 = await sha256File(artifact.reportPath)
    append(agent, 'governance/attestation-issued', {
      workId: state.workId,
      runId,
      level,
      gitHead: report.git_head,
      profileSha256: report.profile_sha256,
      changeFingerprint: report.change_fingerprint,
      attestationSha256,
      reportPath: artifact.reportPath,
      logPath: artifact.logPath,
      logSha256: artifact.logSha256,
      issuedAt: now(),
    })
    await this.ctx.sessions.flush(agent.session)
    return {
      ok: true,
      runId,
      plan: planned.plan,
      result: result.payload,
      attestation: attest.payload,
      state: this.publicState(agent),
    }
  }

  freshness(project, level = 'full') {
    const result = runGovernanceSync(
      this.config,
      'attest',
      project,
      ['--report', '@git', '--require-level', level],
    )
    const checks = Array.isArray(result.payload?.items) ? result.payload.items : []
    return {
      ok: result.code === 0 && result.payload !== null && checks.length > 0 && checks.every(item => item.status === 'ok'),
      code: result.code,
      payload: result.payload,
      timedOut: result.timedOut,
    }
  }

  invalidateIfStale(agent) {
    const state = this.state(agent)
    if (!['candidate', 'accepted'].includes(state.phase) || state.attestation === null) return state
    const fresh = this.freshness(projectFor(agent), state.attestation.level)
    if (fresh.ok) return state
    append(agent, 'governance/invalidated', {
      workId: state.workId,
      reasonCode: fresh.timedOut ? 'attestation-timeout' : 'stale-evidence',
      message: 'HEAD, profile, changed paths, or file bytes no longer match the attestation',
      invalidatedAt: now(),
    })
    return this.state(agent)
  }

  async requestCompletion(agent) {
    let state = this.ensureWork(agent)
    append(agent, 'governance/completion-requested', {
      workId: state.workId,
      requestedAt: now(),
    })
    state = this.invalidateIfStale(agent)
    if (state.phase !== 'candidate' || state.attestation === null || state.attestation.level !== 'full') {
      append(agent, 'governance/completion-rejected', {
        workId: state.workId,
        reasonCode: state.phase === 'invalidated' ? 'stale-evidence' : 'missing-full-attestation',
        message: 'completion requires a fresh full attestation',
        terminal: false,
        rejectedAt: now(),
      })
      await this.ctx.sessions.flush(agent.session)
      return { ok: false, state: this.publicState(agent) }
    }
    append(agent, 'governance/completion-accepted', {
      workId: state.workId,
      runId: state.attestation.runId,
      attestationSha256: state.attestation.attestationSha256,
      gitHead: state.attestation.gitHead,
      acceptedAt: now(),
    })
    await this.ctx.sessions.flush(agent.session)
    return { ok: true, state: this.publicState(agent) }
  }

  classifyExecution(exec) {
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    if (this.config.compiledDeliveryPatterns.some(pattern => pattern.test(command))) return 'delivery'
    if (this.config.compiledCommitPatterns.some(pattern => pattern.test(command))) return 'commit'
    if (this.config.mutationToolNames.includes(exec.name)) return 'mutation'
    if (this.config.compiledMutationPatterns.some(pattern => pattern.test(command))) return 'mutation'
    return 'other'
  }

  guardExecution(exec) {
    if (exec.agent === undefined) return undefined
    if (!this.applies(exec.agent)) return undefined
    const kind = this.classifyExecution(exec)
    if (kind !== 'commit' && kind !== 'delivery') return undefined
    this.ensureWork(exec.agent)
    const state = this.invalidateIfStale(exec.agent)
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    let decision
    if (kind === 'commit') {
      decision = state.phase === 'candidate' && state.attestation !== null
        ? { allowed: true, reasonCode: 'fresh-candidate', message: 'commit admitted by fresh candidate attestation' }
        : {
            allowed: false,
            reasonCode: 'missing-candidate',
            message: 'Code-as-Harness: git commit requires a fresh governance candidate attestation',
          }
    } else {
      decision = state.phase === 'accepted' && state.attestation !== null
        ? { allowed: true, reasonCode: 'accepted', message: 'delivery admitted by accepted governance evidence' }
        : {
            allowed: false,
            reasonCode: 'missing-acceptance',
            message: 'Code-as-Harness: push, PR, release, and deployment require governance accepted status',
          }
    }
    append(exec.agent, 'governance/milestone-evaluated', {
      workId: state.workId,
      kind,
      decision: decision.allowed ? 'allowed' : 'denied',
      toolName: exec.name,
      commandSha256: sha256(command),
      phase: state.phase,
      reasonCode: decision.reasonCode,
      message: decision.message,
      evaluatedAt: now(),
    })
    return decision.allowed ? undefined : decision.message
  }

  markMutation(agent, reason) {
    const state = this.state(agent)
    if (!this.applies(agent)) return state
    if (!['candidate', 'accepted', 'rejected'].includes(state.phase)) return state
    append(agent, 'governance/invalidated', {
      workId: state.workId,
      reasonCode: 'tool-mutation',
      message: `tool execution changed governed state: ${reason}`,
      invalidatedAt: now(),
    })
    return this.state(agent)
  }

  rejectStop(agent) {
    const state = this.state(agent)
    if (!this.applies(agent)) return { continue: false, state }
    if (state.phase === 'accepted' || state.phase === 'blocked' || state.phase === 'unmanaged') {
      return { continue: false, state }
    }
    const nextCount = state.continuationRejections + 1
    const terminal = nextCount >= this.config.maxContinuationRejections
    append(agent, 'governance/completion-rejected', {
      workId: state.workId,
      reasonCode: 'unverified-stop',
      message: terminal
        ? 'maximum corrective continuations reached without accepted evidence'
        : 'agent attempted to stop before governance accepted the work',
      terminal,
      rejectedAt: now(),
    })
    return { continue: !terminal, state: this.state(agent) }
  }

  publicState(agent) {
    const state = this.state(agent)
    return {
      phase: state.phase,
      workId: state.workId,
      project: state.project,
      gates: state.gates.map(gate => ({
        id: gate.gateId,
        status: gate.status,
        durationSeconds: gate.durationSeconds,
        outputSha256: gate.outputSha256,
      })),
      attestation: state.attestation === null ? null : {
        runId: state.attestation.runId,
        level: state.attestation.level,
        gitHead: state.attestation.gitHead,
        attestationSha256: state.attestation.attestationSha256,
        issuedAt: state.attestation.issuedAt,
      },
      rejection: state.lastRejection,
      acceptedAt: state.acceptedAt,
      continuationRejections: state.continuationRejections,
      traceEventCount: agent.session.events.filter(isGovernanceEvent).length,
    }
  }
}
