import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { RunStore } from '../src/store.js'
import { RlmHost } from '../src/core.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-store-')); directories.push(directory)
  const store = new RunStore(directory)
  const record = await store.create({ ownerSessionId: 'owner', cwd: directory, route: { provider: 'fixture', model: 'only', reasoningEffort: 'off' }, label: 'Selected task', maxModelRequests: 3, maxWallTimeMs: 10_000 })
  return { directory, store, record }
}

describe('durable run evidence and recovery fence', () => {
  it('rejects an invalid native depth cap before creating a run or dispatching a model', async () => {
    const { directory, store } = await fixture()
    const before = await store.list()
    for (const rlmMaxDepth of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RlmHost({} as Context, directory, '/unused-package', 100, { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth })).toThrow('RLM_NATIVE_DEPTH_INVALID')
    }
    expect(await store.list()).toEqual(before)
    const host = new RlmHost({} as Context, directory, '/unused-package', 100, { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth: 0 })
    await host.dispose()
  })

  it('serializes complete journal lines and snapshots a manifest before waiting for its writer', async () => {
    const { directory, store, record } = await fixture()
    const operations = Array.from({ length: 20 }, (_, ordinal) => store.append(record.runId, { ordinal, text: '中文\nJSON text' }))
    record.state = 'running'
    const saved = store.save(record)
    record.state = 'idle'
    await Promise.all([...operations, saved])
    const lines = (await readFile(join(directory, 'runs', record.runId, 'journal.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.value.ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index))
    expect(lines.every(line => line.formatVersion === 1 && line.value.text === '中文\nJSON text')).toBe(true)
    expect((await store.get(record.runId)).state).toBe('running')
  })

  it('refuses an unknown durable format and invalid path identity', async () => {
    const { directory, store, record } = await fixture()
    await writeFile(join(directory, 'runs', record.runId, 'manifest.json'), JSON.stringify({ ...record, formatVersion: 2 }))
    await expect(store.get(record.runId)).rejects.toThrow('RLM_FORMAT_UNSUPPORTED')
    await expect(store.get('../another-run')).rejects.toThrow('RLM_RUN_ID')
  })

  it('marks an unowned old live connection indeterminate and never replays it', async () => {
    const { directory, store, record } = await fixture()
    record.state = 'running'; await store.save(record)
    const host = new RlmHost({} as Context, directory, '/unused-package', 100)
    expect((await host.inspect(record.runId, 'owner')).state).toBe('indeterminate')
    await expect(host.continue(record.runId, 'A new turn', { sessionId: 'owner', route: record.route })).rejects.toThrow('RLM_RESUME_FENCED')
    await expect(host.inspect(record.runId, 'different-owner')).rejects.toThrow('RLM_OWNER_REQUIRED')
    await host.dispose()
  })

  it('rejects a changed model route before any native launch or model dispatch', async () => {
    const { directory, store, record } = await fixture()
    record.state = 'cancelled'; record.sessionFile = '/not-opened'; await store.save(record)
    const host = new RlmHost({} as Context, directory, '/unused-package', 100)
    await expect(host.continue(record.runId, 'New task', { sessionId: 'owner', route: { ...record.route, model: 'stronger' } })).rejects.toThrow('RLM_ROUTE_CHANGED')
    await host.dispose()
  })
})
