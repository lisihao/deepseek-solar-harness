import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFreshCodexCatalog } from '../src/codex-catalog.ts'
import { collectCodexModelsAndQuota } from '../src/drivers.ts'

const roots: string[] = []

interface FakeCatalogState {
  readonly models: readonly Record<string, unknown>[]
  readonly failModels?: boolean
  readonly failQuota?: boolean
}

interface FakeCatalogCall {
  readonly kind: 'started' | 'method' | 'stdin-ended' | 'exited'
  readonly method?: string
  readonly pid?: number
}

function model(name: string): Record<string, unknown> {
  return {
    id: name,
    model: name,
    displayName: name,
    description: 'Fixture model',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
  }
}

function writeState(root: string, state: FakeCatalogState): void {
  writeFileSync(join(root, 'state.json'), JSON.stringify(state))
}

function calls(root: string): FakeCatalogCall[] {
  const path = join(root, 'calls.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeCatalogCall)
    : []
}

function fakeCodex(root: string): string {
  const executable = join(root, 'codex')
  writeFileSync(executable, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const root = dirname(process.argv[1])
const log = (value) => appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(value) + '\\n')
const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
log({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) })
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (typeof request.method !== 'string') continue
    log({ kind: 'method', method: request.method })
    if (request.id === undefined) continue
    const current = state()
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: {} })
    } else if (request.method === 'model/list') {
      if (current.failModels) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture model failure' } })
      else send({ jsonrpc: '2.0', id: request.id, result: { data: current.models } })
    } else if (request.method === 'account/rateLimits/read') {
      if (current.failQuota) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture quota failure' } })
      else send({ jsonrpc: '2.0', id: request.id, result: { rateLimits: { primary: { usedPercent: 10 } }, rateLimitsByLimitId: null } })
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected method' } })
    }
  }
})
process.stdin.on('end', () => { log({ kind: 'stdin-ended' }); process.exit(0) })
process.on('exit', () => { log({ kind: 'exited', pid: process.pid }) })
`)
  chmodSync(executable, 0o700)
  return executable
}

function fixture(): { readonly root: string; readonly executable: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-catalog-'))
  roots.push(root)
  return { root, executable: fakeCodex(root) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('fresh Codex app-server catalog', () => {
  it('starts a new read-only app-server for each catalog and closes both children', async () => {
    const { root, executable } = fixture()
    writeState(root, { models: [model('gpt-5.6-sol')] })
    const first = await readFreshCodexCatalog(executable, collectCodexModelsAndQuota)
    writeState(root, { models: [model('gpt-6.1-sol')] })
    const second = await readFreshCodexCatalog(executable, collectCodexModelsAndQuota)

    expect(first.models.map(entry => entry.model)).toEqual(['gpt-5.6-sol'])
    expect(second.models.map(entry => entry.model)).toEqual(['gpt-6.1-sol'])
    const recorded = calls(root)
    const started = recorded.filter(entry => entry.kind === 'started')
    expect(started).toHaveLength(2)
    expect(new Set(started.map(entry => entry.pid))).toHaveLength(2)
    expect(recorded.filter(entry => entry.kind === 'exited')).toHaveLength(2)
    expect(recorded.filter(entry => entry.kind === 'method').map(entry => entry.method)).not.toContain('thread/start')
    expect(recorded.filter(entry => entry.kind === 'method').map(entry => entry.method)).not.toContain('turn/start')
  })

  it('closes the short-lived child after a catalog control failure', async () => {
    const { root, executable } = fixture()
    writeState(root, { models: [model('gpt-6.1-sol')], failModels: true })

    await expect(readFreshCodexCatalog(executable, collectCodexModelsAndQuota)).rejects.toThrow('fixture model failure')
    expect(calls(root).filter(entry => entry.kind === 'exited')).toHaveLength(1)
  })

  it('keeps the existing non-fatal quota telemetry result while closing the child', async () => {
    const { root, executable } = fixture()
    writeState(root, { models: [model('gpt-6.1-sol')], failQuota: true })

    const result = await readFreshCodexCatalog(executable, collectCodexModelsAndQuota)

    expect(result.models.map(entry => entry.model)).toEqual(['gpt-6.1-sol'])
    expect(result.quotaPools).toEqual([])
    expect(result.quotaUnavailableReason).toContain('fixture quota failure')
    expect(calls(root).filter(entry => entry.kind === 'exited')).toHaveLength(1)
  })

  it('surfaces a real app-server spawn failure', async () => {
    const { root } = fixture()

    await expect(readFreshCodexCatalog(join(root, 'missing-codex'), collectCodexModelsAndQuota))
      .rejects.toThrow(/missing-codex|ENOENT/u)
  })
})
