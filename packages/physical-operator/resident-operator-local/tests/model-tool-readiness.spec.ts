import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { LocalJsonRpcRequestServer } from '@deepseek-ai/dsh-sdk-protocol'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorCommandId, type ResidentDriverExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import { ClaudeCodeResidentDriver, CodexResidentDriver, createCodexRlmToolHandler } from '../src/drivers.ts'
import { verifyModelToolBridgeReady } from '../src/model-tool-bridge.ts'

const roots: string[] = []
const servers: LocalJsonRpcRequestServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(response: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-ready-'))
  roots.push(root)
  const path = localIpcAddress(root, 'probe')
  const requests: string[] = []
  const server = new LocalJsonRpcRequestServer({ path, ...localIpcUsesFilesystem() ? { directory: root } : {} }, async (method) => {
    requests.push(method)
    return response
  })
  servers.push(server)
  await server.start()
  const bridge: PhysicalOperatorModelToolBridgeV1 = {
    version: 1, socketPath: path, sessionId: 'session-1',
    tools: [{ name: 'bash', description: 'DSH command', inputSchema: { type: 'object' } }],
  }
  return { bridge, requests, server }
}

it('checks the active catalog before execution without calling a business tool', async () => {
  const { bridge, requests } = await fixture({ version: 1, sessionId: 'session-1', tools: ['bash'] })
  await verifyModelToolBridgeReady(bridge, AbortSignal.timeout(1000))
  expect(requests).toEqual(['tool.describe'])
})

it.each([
  { version: 1, sessionId: 'other', tools: ['bash'] },
  { version: 1, sessionId: 'session-1', tools: [] },
  { version: 1, sessionId: 'session-1', tools: ['native-shell'] },
  { version: 1, sessionId: 'session-1', tools: ['bash', 'bash'] },
  { version: 2, sessionId: 'session-1', tools: ['bash'] },
])('rejects a bridge description that differs from the sealed descriptor: %j', async (response) => {
  const { bridge } = await fixture(response)
  await expect(verifyModelToolBridgeReady(bridge, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
})

it('reports an unreachable owner before any model execution', async () => {
  const { bridge, server } = await fixture({})
  await server.dispose()
  await expect(verifyModelToolBridgeReady(bridge, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})


it.each([CodexResidentDriver, ClaudeCodeResidentDriver])('rejects an unavailable bridge before provider qualification: %s', async (Driver) => {
  const { bridge, server } = await fixture({})
  await server.dispose()
  const driver = new Driver()
  const qualify = vi.spyOn(driver, 'qualify')
  const progress = vi.fn()
  const request: ResidentDriverExecuteRequest = {
    commandId: ResidentOperatorCommandId('bridge-preflight'), workspace: tmpdir(),
    prompt: [{ type: 'text', text: 'Create a file' }], profile: { model: 'gpt-test' },
    signal: AbortSignal.timeout(1000), nativeToolPolicy: 'dsh-tools-authoritative',
    modelToolBridge: bridge, onRunning: vi.fn(), onProgress: progress, onObservation: vi.fn(),
  }
  await expect(driver.execute(request)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(qualify).not.toHaveBeenCalled()
  expect(progress).not.toHaveBeenCalled()
  await expect(driver.execute({ ...request, modelToolBridge: undefined }))
    .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  expect(qualify).not.toHaveBeenCalled()
})


it('abandons an unresponsive bridge probe when admission is cancelled', async () => {
  const response = Promise.withResolvers<unknown>()
  const { bridge, requests } = await fixture(response.promise)
  const controller = new AbortController()
  const ready = verifyModelToolBridgeReady(bridge, controller.signal)
  try {
    await vi.waitFor(() => { expect(requests).toEqual(['tool.describe']) })
    controller.abort(new Error('admission deadline reached'))
    await expect(ready).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  } finally {
    response.resolve({ version: 1, sessionId: 'session-1', tools: ['bash'] })
  }
})


it('routes subsequent native calls to a reattached owner without replaying previous calls', async () => {
  const first = await fixture({ value: 'first owner' })
  const second = await fixture({ value: 'second owner' })
  let current = first.bridge
  const handler = createCodexRlmToolHandler('reattach-command', first.bridge, AbortSignal.timeout(2000), () => current)
  const call = { threadId: 'thread', turnId: 'turn', tool: 'bash', arguments: {} }
  await expect(handler({ ...call, callId: 'first-call' }))
    .resolves.toEqual({ success: true, text: '{"value":"first owner"}' })
  await first.server.dispose()
  current = second.bridge
  await expect(handler({ ...call, callId: 'second-call' }))
    .resolves.toEqual({ success: true, text: '{"value":"second owner"}' })
  expect(first.requests).toEqual(['tool.call'])
  expect(second.requests).toEqual(['tool.call'])
})


it.each([CodexResidentDriver, ClaudeCodeResidentDriver])('bounds bridge admission without aborting the whole turn: %s', async (Driver) => {
  const response = Promise.withResolvers<unknown>()
  const { bridge } = await fixture(response.promise)
  const driver = new Driver()
  const qualify = vi.spyOn(driver, 'qualify')
  const controller = new AbortController()
  try {
    await expect(driver.execute({
      commandId: ResidentOperatorCommandId('bounded-admission'), workspace: tmpdir(),
      prompt: [{ type: 'text', text: 'Create a file' }], profile: { model: 'gpt-test' },
      signal: controller.signal, modelToolBridgeAdmissionTimeoutMs: 25,
      nativeToolPolicy: 'dsh-tools-authoritative', modelToolBridge: bridge,
      onRunning: vi.fn(), onProgress: vi.fn(), onObservation: vi.fn(),
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(controller.signal.aborted).toBe(false)
    expect(qualify).not.toHaveBeenCalled()
  } finally {
    response.resolve({ version: 1, sessionId: 'session-1', tools: ['bash'] })
  }
})
