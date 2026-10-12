import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const QUALIFICATION_FILE = 'physical-routing-qualification-count'

async function recordQualification() {
  const home = process.env.DSH_HOME
  if (home === undefined) return
  await mkdir(home, { recursive: true })
  const path = join(home, QUALIFICATION_FILE)
  const previous = Number.parseInt(await readFile(path, 'utf8').catch(() => '0'), 10)
  await writeFile(path, `${Number.isFinite(previous) ? previous + 1 : 1}\n`)
}

const codex = {
  operatorId: 'codex',
  product: 'fake-codex',
  displayName: 'Fake Codex',
  description: 'Keyless test-only Codex Resident provider.',
  tags: ['test', 'subscription'],
  maxConcurrency: 4,
  injectionBoundaries: ['pre-dispatch', 'next-turn', 'checkpoint'],
  available: true,
  authentication: 'native-subscription',
  productVersion: 'fake-codex-1',
  protocolHash: '0'.repeat(64),
  models: [{
    model: 'fake-codex-main',
    displayName: 'Fake Codex Main',
    description: 'Deterministic keyless E2E model.',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    isDefault: true,
    supportsAdaptiveThinking: true,
  }],
}

const claude = {
  operatorId: 'claude-code',
  product: 'fake-claude-code',
  displayName: 'Fake Claude Code',
  description: 'Keyless test-only Claude Code Resident provider.',
  tags: ['test', 'subscription'],
  maxConcurrency: 4,
  injectionBoundaries: ['pre-dispatch', 'next-turn', 'checkpoint'],
  available: false,
  unavailableReason: 'AUTH_MODE_MISMATCH: fake Claude subscription is not authenticated',
  unavailableCode: 'AUTH_MODE_MISMATCH',
  authentication: 'unqualified',
  supportsExplicitAuthentication: true,
  productVersion: 'fake-claude-1',
  protocolHash: '0'.repeat(64),
  models: [],
}

const RESIDENT_TIME = '2026-09-29T20:38:52.090Z'
const RESIDENT_SESSION_ID = 'physical-routing-resident-session'
const RESIDENT_TURN_ID = 'physical-routing-resident-turn'
const RESIDENT_COMMAND_ID = 'physical-routing-resident-command'
const RESIDENT_TASK_LABEL = 'Create and test a file'

const residentEvents = [
  {
    sequence: 1,
    sessionId: RESIDENT_SESSION_ID,
    type: 'turn.accepted',
    time: RESIDENT_TIME,
    data: {
      commandId: RESIDENT_COMMAND_ID,
      turnId: RESIDENT_TURN_ID,
      taskLabel: RESIDENT_TASK_LABEL,
    },
  },
  {
    sequence: 2,
    sessionId: RESIDENT_SESSION_ID,
    type: 'turn.running',
    time: RESIDENT_TIME,
    data: {
      commandId: RESIDENT_COMMAND_ID,
      turnId: RESIDENT_TURN_ID,
      taskLabel: RESIDENT_TASK_LABEL,
    },
  },
  {
    sequence: 3,
    sessionId: RESIDENT_SESSION_ID,
    type: 'turn.observation',
    time: RESIDENT_TIME,
    data: {
      commandId: RESIDENT_COMMAND_ID,
      turnId: RESIDENT_TURN_ID,
      kind: 'public-output',
      preview: 'Cannot write files; tests were not run.',
    },
  },
  {
    sequence: 4,
    sessionId: RESIDENT_SESSION_ID,
    type: 'turn.settled',
    time: RESIDENT_TIME,
    data: {
      commandId: RESIDENT_COMMAND_ID,
      turnId: RESIDENT_TURN_ID,
      stopReason: 'completed',
    },
  },
]

const residentTurn = {
  commandId: RESIDENT_COMMAND_ID,
  turnId: RESIDENT_TURN_ID,
  sessionId: RESIDENT_SESSION_ID,
  stateRevision: 4,
  state: 'settled',
  taskLabel: RESIDENT_TASK_LABEL,
  stopReason: 'completed',
  updatedAt: RESIDENT_TIME,
  result: {
    output: [{ type: 'text', text: 'Cannot write files; tests were not run.' }],
    stopReason: 'completed',
  },
}

const residentSession = {
  sessionId: RESIDENT_SESSION_ID,
  operatorId: 'codex',
  workspace: '/workspace/physical-routing',
  laneId: 'web-e2e',
  lifecycle: 'idle',
  health: 'ok',
  control: 'automation',
  stateRevision: 4,
  executionProfile: { model: 'fake-codex-main', effort: 'medium' },
  executionProfileSource: 'manual',
  latestTurn: {
    commandId: RESIDENT_COMMAND_ID,
    turnId: RESIDENT_TURN_ID,
    state: 'settled',
    taskLabel: RESIDENT_TASK_LABEL,
    stopReason: 'completed',
    updatedAt: RESIDENT_TIME,
  },
  latestEvent: residentEvents[residentEvents.length - 1],
  updatedAt: RESIDENT_TIME,
}

function residentOperators() {
  const runtimes = [
    { product: 'claude-code', currentVersion: '2.1.239', latestVersion: '2.1.281', updateAvailable: true, managed: false },
    { product: 'codex', currentVersion: '0.149.1', latestVersion: '0.156.1', updateAvailable: true, managed: false },
  ]
  return {
    async cliRuntimes() { return runtimes.map(runtime => ({ ...runtime })) },
    async updateCli(product) {
      if (product === 'codex') {
        return { product, version: '0.156.1', status: 'incompatible', reason: 'app-server lacks required methods: ClientRequest:turn/interrupt' }
      }
      runtimes[0] = { ...runtimes[0], currentVersion: '2.1.281', updateAvailable: false, managed: true }
      return { product, version: '2.1.281', status: 'activated' }
    },
    async providers() {
      await recordQualification()
      return [codex, claude]
    },
    providerSnapshot() { return undefined },
    async authenticate() {
      throw Object.assign(new Error('fake Claude subscription is not authenticated'), { code: 'AUTH_MODE_MISMATCH' })
    },
    async list() { return [residentSession] },
    async inspect() { return residentSession },
    async inspectTurn() { return residentTurn },
    async readEvents() { return { events: residentEvents, nextSequence: residentEvents.length + 1 } },
    async execute() { throw new Error('fake Resident execute is not used by this test') },
    async interrupt() {},
    async compact() { throw new Error('fake Resident compact is not used by this test') },
    async reset() { throw new Error('fake Resident reset is not used by this test') },
    async resolveIndeterminate() {},
  }
}

function orchestrations() {
  const unavailable = async () => { throw new Error('fake orchestration execution is not used by this test') }
  return {
    compile: unavailable,
    start: unavailable,
    list: async () => [],
    inspect: unavailable,
    readEvents: async () => ({ events: [], nextSequence: 0 }),
    readArtifact: unavailable,
    control: unavailable,
    decide: unavailable,
    resolveIndeterminate: unavailable,
    resolveAutoRefineIndeterminate: unavailable,
    proposeCapabilityUpdate: unavailable,
    clusterStatus: async () => undefined,
    clusterRequestVote: unavailable,
    clusterHeartbeat: unavailable,
    clusterExportReplica: unavailable,
    clusterInstallReplica: unavailable,
  }
}

export function apply(ctx) {
  ctx.provide('residentOperators', residentOperators())
  ctx.provide('orchestrations', orchestrations())
}
