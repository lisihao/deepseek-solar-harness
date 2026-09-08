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

function residentOperators() {
  return {
    async providers() {
      await recordQualification()
      return [codex, claude]
    },
    async authenticate() {
      throw Object.assign(new Error('fake Claude subscription is not authenticated'), { code: 'AUTH_MODE_MISMATCH' })
    },
    async list() { return [] },
    async inspect() { throw new Error('fake Resident inspect is not used by this test') },
    async inspectTurn() { throw new Error('fake Resident inspectTurn is not used by this test') },
    async readEvents() { return { events: [], nextSequence: 0 } },
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
