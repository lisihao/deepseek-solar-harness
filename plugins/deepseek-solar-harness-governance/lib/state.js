const PREFIX = 'governance/'

export const GOVERNANCE_EVENTS = Object.freeze([
  'governance/work-opened',
  'governance/plan-recorded',
  'governance/run-started',
  'governance/gate-finished',
  'governance/attestation-issued',
  'governance/completion-requested',
  'governance/completion-rejected',
  'governance/completion-accepted',
  'governance/invalidated',
])

const EVENT_SET = new Set(GOVERNANCE_EVENTS)
const ACTIVE_PHASES = new Set(['open', 'planned', 'verifying', 'candidate', 'rejected', 'invalidated'])

function fail(message) {
  throw new Error(`governance event violation: ${message}`)
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value
}

function timestamp(value, label) {
  text(value, label)
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp`)
  return value
}

function status(value, label) {
  if (value !== 'ok' && value !== 'warn' && value !== 'error' && value !== 'pending') {
    fail(`${label} must be ok, warn, error, or pending`)
  }
  return value
}

function initialState() {
  return {
    phase: 'unmanaged',
    workId: null,
    project: null,
    openedAt: null,
    plan: null,
    run: null,
    gates: [],
    attestation: null,
    completionRequested: false,
    lastRejection: null,
    acceptedAt: null,
    invalidatedAt: null,
    continuationRejections: 0,
  }
}

function cloneState(state) {
  return {
    ...state,
    plan: state.plan === null ? null : { ...state.plan, gates: [...state.plan.gates] },
    run: state.run === null ? null : { ...state.run },
    gates: state.gates.map(gate => ({ ...gate })),
    attestation: state.attestation === null ? null : { ...state.attestation },
    lastRejection: state.lastRejection === null ? null : { ...state.lastRejection },
  }
}

function requireWork(state, data) {
  text(data.workId, 'workId')
  if (state.workId === null) fail(`${data.workId} has no opened work`)
  if (data.workId !== state.workId) fail(`workId ${data.workId} does not match ${state.workId}`)
}

function gateIds(data) {
  if (!Array.isArray(data.gates) || data.gates.some(item => typeof item !== 'string' || item === '')) {
    fail('gates must be an array of non-empty strings')
  }
  if (new Set(data.gates).size !== data.gates.length) fail('gates must be unique')
  return [...data.gates]
}

export function isGovernanceEvent(event) {
  return typeof event?.type === 'string' && event.type.startsWith(PREFIX)
}

export function applyGovernanceEvent(source, event) {
  if (!isGovernanceEvent(event)) return cloneState(source)
  if (!EVENT_SET.has(event.type)) fail(`unknown event type ${event.type}`)
  const state = cloneState(source)
  const data = record(event.data, `${event.type} data`)

  switch (event.type) {
    case 'governance/work-opened': {
      if (!['unmanaged', 'accepted', 'blocked'].includes(state.phase)) {
        fail(`work-opened cannot follow phase ${state.phase}`)
      }
      text(data.workId, 'workId')
      text(data.project, 'project')
      timestamp(data.openedAt, 'openedAt')
      return {
        ...initialState(),
        phase: 'open',
        workId: data.workId,
        project: data.project,
        openedAt: data.openedAt,
      }
    }
    case 'governance/plan-recorded': {
      requireWork(state, data)
      if (!ACTIVE_PHASES.has(state.phase)) fail(`plan-recorded cannot follow phase ${state.phase}`)
      timestamp(data.recordedAt, 'recordedAt')
      const gates = gateIds(data)
      text(data.level, 'level')
      text(data.scope, 'scope')
      state.phase = 'planned'
      state.plan = {
        level: data.level,
        scope: data.scope,
        gates,
        changedFilesSha256: text(data.changedFilesSha256, 'changedFilesSha256'),
        recordedAt: data.recordedAt,
      }
      return state
    }
    case 'governance/run-started': {
      requireWork(state, data)
      if (!ACTIVE_PHASES.has(state.phase)) fail(`run-started cannot follow phase ${state.phase}`)
      text(data.runId, 'runId')
      text(data.level, 'level')
      text(data.scope, 'scope')
      timestamp(data.startedAt, 'startedAt')
      state.phase = 'verifying'
      state.run = {
        runId: data.runId,
        level: data.level,
        scope: data.scope,
        startedAt: data.startedAt,
      }
      state.gates = []
      state.attestation = null
      state.completionRequested = false
      return state
    }
    case 'governance/gate-finished': {
      requireWork(state, data)
      if (state.phase !== 'verifying' || state.run === null) {
        fail('gate-finished requires a verifying run')
      }
      if (data.runId !== state.run.runId) fail('gate-finished runId does not match active run')
      text(data.gateId, 'gateId')
      status(data.status, 'status')
      timestamp(data.finishedAt, 'finishedAt')
      if (state.gates.some(gate => gate.gateId === data.gateId)) fail(`duplicate gate ${data.gateId}`)
      state.gates.push({
        gateId: data.gateId,
        status: data.status,
        returncode: data.returncode ?? null,
        durationSeconds: data.durationSeconds ?? null,
        outputSha256: text(data.outputSha256, 'outputSha256'),
        finishedAt: data.finishedAt,
      })
      return state
    }
    case 'governance/attestation-issued': {
      requireWork(state, data)
      if (state.phase !== 'verifying' || state.run === null) {
        fail('attestation-issued requires a verifying run')
      }
      if (data.runId !== state.run.runId) fail('attestation runId does not match active run')
      if (state.gates.length === 0 || state.gates.some(gate => gate.status !== 'ok')) {
        fail('attestation-issued requires at least one successful gate and no failures')
      }
      timestamp(data.issuedAt, 'issuedAt')
      state.phase = 'candidate'
      state.attestation = {
        runId: data.runId,
        level: text(data.level, 'level'),
        gitHead: text(data.gitHead, 'gitHead'),
        profileSha256: text(data.profileSha256, 'profileSha256'),
        changeFingerprint: text(data.changeFingerprint, 'changeFingerprint'),
        attestationSha256: text(data.attestationSha256, 'attestationSha256'),
        reportPath: text(data.reportPath, 'reportPath'),
        issuedAt: data.issuedAt,
      }
      return state
    }
    case 'governance/completion-requested': {
      requireWork(state, data)
      if (!ACTIVE_PHASES.has(state.phase)) {
        fail(`completion-requested cannot follow phase ${state.phase}`)
      }
      timestamp(data.requestedAt, 'requestedAt')
      state.completionRequested = true
      return state
    }
    case 'governance/completion-rejected': {
      requireWork(state, data)
      if (!ACTIVE_PHASES.has(state.phase)) {
        fail(`completion-rejected cannot follow phase ${state.phase}`)
      }
      timestamp(data.rejectedAt, 'rejectedAt')
      const terminal = data.terminal === true
      state.phase = terminal ? 'blocked' : 'rejected'
      state.lastRejection = {
        reasonCode: text(data.reasonCode, 'reasonCode'),
        message: text(data.message, 'message'),
        rejectedAt: data.rejectedAt,
        terminal,
      }
      if (data.reasonCode === 'unverified-stop') state.continuationRejections += 1
      return state
    }
    case 'governance/completion-accepted': {
      requireWork(state, data)
      if (state.phase !== 'candidate' || state.attestation === null || !state.completionRequested) {
        fail('completion-accepted requires a requested candidate attestation')
      }
      if (data.runId !== state.attestation.runId) fail('accepted runId does not match attestation')
      if (data.attestationSha256 !== state.attestation.attestationSha256) {
        fail('accepted attestation digest does not match candidate')
      }
      if (data.gitHead !== state.attestation.gitHead) fail('accepted Git HEAD does not match candidate')
      timestamp(data.acceptedAt, 'acceptedAt')
      state.phase = 'accepted'
      state.acceptedAt = data.acceptedAt
      return state
    }
    case 'governance/invalidated': {
      requireWork(state, data)
      if (!['candidate', 'accepted', 'rejected', 'invalidated'].includes(state.phase)) {
        fail(`invalidated cannot follow phase ${state.phase}`)
      }
      timestamp(data.invalidatedAt, 'invalidatedAt')
      state.phase = 'invalidated'
      state.invalidatedAt = data.invalidatedAt
      state.lastRejection = {
        reasonCode: text(data.reasonCode, 'reasonCode'),
        message: text(data.message, 'message'),
        rejectedAt: data.invalidatedAt,
        terminal: false,
      }
      return state
    }
    default:
      fail(`unhandled event type ${event.type}`)
  }
}

export function foldGovernance(events) {
  let state = initialState()
  for (const event of events) state = applyGovernanceEvent(state, event)
  return state
}

export function emptyGovernanceState() {
  return initialState()
}
