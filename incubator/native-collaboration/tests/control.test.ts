import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ResidentApi, GraphSnapshot } from '../../native-resident/src/contracts.js'
import { NativeControl, CHECK_MARKERS } from '../src/control.js'

function snapshot(): GraphSnapshot { return { formatVersion: 1, graph: { formatVersion: 1, id: 'g', label: 'A task', cwd: '/tmp', maxParallel: 1, nodes: [] }, status: 'queued', revision: 4, createdAt: 1, updatedAt: 1, nodes: [] } }
function setup(available = true) {
  const ctx = new Context()
  const resident = { protocolVersion: 1, list: vi.fn(async () => [snapshot()]), inspect: vi.fn(async () => snapshot()), control: vi.fn(async () => snapshot()), submit: vi.fn(async () => snapshot()) } as unknown as ResidentApi
  ctx.provide('tools', { get: (name: string) => name !== 'missing' ? {} : undefined } as never)
  ctx.provide('subagents', { getProvider: (name: string) => name === 'codex' ? {} : undefined } as never)
  if (available) ctx.provide('solarNativeResident', resident as never)
  const service = new NativeControl(ctx, { codex: 'codex', claudeCode: 'claude-code' }, ['solar_delegate', 'solar_coordinate'])
  return { ctx, service, resident }
}
afterEach(() => vi.unstubAllEnvs())
describe('native UI Host controls', () => {
  test('refresh reads real service state without submitting work or discovering models', async () => {
    const { service, resident } = setup()
    const view = await service.status()
    expect(view.resident.available).toBe(true)
    expect(view.providers.map(value => value.available)).toEqual([true, false])
    expect(view.tools.map(value => value.name)).toEqual(['solar_resident', 'solar_delegate', 'solar_coordinate'])
    expect(resident.submit).not.toHaveBeenCalled()
    expect(resident.control).not.toHaveBeenCalled()
  })
  test('missing Resident is visible rather than a successful empty refresh', async () => {
    const { service } = setup(false)
    const view = await service.status()
    expect(view.resident.available).toBe(false)
    expect(view.resident.message).toContain('RESIDENT_UNAVAILABLE')
    await expect(service.inspect({ graphId: 'g' })).rejects.toThrow('RESIDENT_UNAVAILABLE')
    await expect(service.control({ graphId: 'g', commandId: 'c', action: 'pause', expectedRevision: 4 })).rejects.toThrow('RESIDENT_UNAVAILABLE')
    await expect(service.test({ commandId: 'a13b9ba8-4f95-440f-b104-a722335b6364', executor: 'codex' })).rejects.toThrow('RESIDENT_UNAVAILABLE')
  })
  test('invalid/extra control fields reject before any persistent mutation', async () => {
    const { service, resident } = setup()
    await expect(service.control({ graphId: 'g', commandId: 'c', action: 'pause', expectedRevision: -1 })).rejects.toThrow()
    await expect(service.control({ graphId: 'g', commandId: 'c', action: 'pause', expectedRevision: 4, retry: true } as never)).rejects.toThrow()
    expect(resident.control).not.toHaveBeenCalled()
  })
  test.each(['a/b', '任务.图', 'g'.repeat(256)])('legal Resident graph identity %s passes through UI queries and controls', async graphId => {
    const { service, resident } = setup()
    await service.inspect({ graphId })
    const input = { graphId, commandId: 'control-command', expectedRevision: 4, action: 'cancel' as const }
    await service.control(input)
    expect(resident.inspect).toHaveBeenCalledExactlyOnceWith(graphId)
    expect(resident.control).toHaveBeenCalledExactlyOnceWith(input)
  })
  test('controls preserve exact observed revision and do not retry unknown effects', async () => {
    const { service, resident } = setup()
    const input = { graphId: 'g', commandId: 'same-command', action: 'cancel' as const, expectedRevision: 4 }
    vi.mocked(resident.control).mockRejectedValueOnce(new Error('COMMAND_INDETERMINATE'))
    await expect(service.control(input)).rejects.toThrow('COMMAND_INDETERMINATE')
    expect(resident.control).toHaveBeenCalledExactlyOnceWith(input)
  })
  test('non-owner Remote callers cannot query, control or launch an acceptance task', async () => {
    const { service, resident } = setup()
    const receiver = Object.create(service) as NativeControl
    Object.defineProperty(receiver, 'ctx', { value: { invocation: { peer: { principal: { kind: 'untrusted-test-peer' } } } } })
    await expect(receiver.status()).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(receiver.inspect({ graphId: 'g' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(receiver.control({ graphId: 'g', commandId: 'c', action: 'pause', expectedRevision: 4 })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(receiver.test({ commandId: 'a13b9ba8-4f95-440f-b104-a722335b6364', executor: 'codex' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    expect(resident.submit).not.toHaveBeenCalled()
  })
  test.each(['codex', 'claude-code'] as const)('explicit %s test has stable identity, owned cwd and no bridge', async executor => {
    const root = await mkdtemp(join(tmpdir(), 'solar-ui-control-'))
    vi.stubEnv('DSH_HOME', root)
    const { service, resident } = setup()
    const commandId = 'a13b9ba8-4f95-440f-b104-a722335b6364'
    try {
      await service.test({ commandId, executor })
      const request = vi.mocked(resident.submit).mock.calls[0]?.[0]
      expect(request?.commandId).toBe(`native-ui-test:${commandId}`)
      expect(request?.graph.id).toBe(`native-check-${commandId}`)
      expect(request?.graph.cwd).toBe(join(root, 'solar', 'native-collaboration', 'check-workspace'))
      expect(request?.graph.bridgeId).toBeUndefined()
      expect(request?.graph.nodes[0]?.prompt).toContain(CHECK_MARKERS[executor])
      expect(request?.graph.nodes[0]?.retry).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
