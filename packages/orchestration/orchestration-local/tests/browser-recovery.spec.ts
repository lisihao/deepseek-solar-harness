import { once } from 'node:events'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { OrchestrationDaemon } from '../src/daemon.ts'
import { BrowserModelToolBridge } from '../src/browser-model-tool-bridge.ts'

const cleanup: Array<() => Promise<void>> = []

type BrowserBridge = {
  readonly version: 1
  readonly socketPath: string
  readonly sessionId: string
  readonly tools: readonly { readonly name: string }[]
}

type ResidentResult = {
  readonly output: Array<{ readonly type: 'text'; readonly text: string }>
  readonly stopReason: 'completed'
}

class RestartableResidentClient {
  readonly requests: Array<{ readonly commandId: string; readonly modelToolBridge?: BrowserBridge }> = []
  private settled = false
  private resolveResult: (() => void) | undefined
  private readonly result = new Promise<ResidentResult>((resolve) => {
    this.resolveResult = () => {
      this.settled = true
      resolve({ output: [{ type: 'text', text: 'recovered' }], stopReason: 'completed' })
    }
  })

  async providers() {
    return [{
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Restart fixture', tags: ['test'],
      maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
      available: true, authentication: 'native-subscription' as const,
      productVersion: 'fixture', protocolHash: 'fixture',
      models: [{ model: 'gpt-5.6-terra', displayName: 'Terra', efforts: ['medium'] as const, defaultEffort: 'medium' as const }],
    }]
  }

  async execute(request: { readonly commandId: string; readonly modelToolBridge?: BrowserBridge }) {
    this.requests.push(request)
    const turnId = `turn:${request.commandId}`
    return {
      turnId,
      sessionId: 'session:codex',
      stateRevision: 1,
      result: this.result,
      dispose: async () => {},
    }
  }

  async inspectTurn(turnId: string) {
    return {
      turnId,
      sessionId: 'session:codex',
      commandId: this.requests[0]?.commandId ?? 'unknown',
      stateRevision: this.settled ? 2 : 1,
      updatedAt: new Date().toISOString(),
      state: this.settled ? 'settled' as const : 'running' as const,
      ...this.settled ? { result: { output: [{ type: 'text' as const, text: 'recovered' }], stopReason: 'completed' as const } } : {},
    }
  }

  async readEvents() {
    return { events: [], nextSequence: 0 }
  }

  async interrupt() {}

  settle(): void {
    this.resolveResult?.()
  }
}

async function callBrowserTool(bridge: BrowserBridge): Promise<Record<string, unknown>> {
  const socket = createConnection(bridge.socketPath)
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    return await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: 'browser-recovery-call',
      tool: 'browser',
      arguments: {
        plan: {
          version: 1,
          workspace: { kind: 'current' },
          operations: [{ kind: 'pages', id: 'list-pages' }],
        },
      },
    }) as Record<string, unknown>
  } finally {
    transport.close()
    socket.destroy()
  }
}

function graph(workspace: string): LogicalTaskGraphV1 {
  return {
    version: 1,
    title: 'browser recovery fixture',
    workspace,
    maxParallel: 1,
    risk: 'low',
    nodes: [{
      id: 'browser', title: 'Browser', task: 'Use the browser.', role: 'implementation', dependsOn: [],
      requiredForCompletion: true,
      capabilityRequirements: [{ capability: 'browser', required: true }],
      capabilityBudget: ['browser'],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'] as const, unavailableSource: 'block' as const },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      approvedSecretRefs: [], readScopes: [], writeScopes: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' as const }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      operator: { preferredIds: ['codex'] },
    }],
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4_000
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`fixture did not converge: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('browser binding restart recovery', () => {
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
  })

  it('recreates the same stable socket/session binding before reattaching a Resident turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-browser-recovery-'))
    const root = join(home, 'orchestrations')
    const resident = new RestartableResidentClient()
    const browserProviderModule = fileURLToPath(new URL('./fixtures/browser-provider.ts', import.meta.url))
    const first = new OrchestrationDaemon({
      root, dshHome: home, residentClient: resident as unknown as ResidentDaemonClient,
      modelWorkerProviders: [], browserProviderModules: [browserProviderModule], schedulerIntervalMs: 10,
    })
    await first.start()
    const client = new OrchestrationDaemonClient({
      root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000,
      browserProviderModules: [browserProviderModule],
    })
    const compilation = await client.compile({ intent: { request: 'Browser recovery fixture.' }, graph: graph(home) })
    const started = await client.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
    await eventually(() => client.inspect(String(started.runId)), value => value.nodes[0]?.state === 'running')
    const originalBridge = resident.requests[0]?.modelToolBridge
    expect(originalBridge).toBeDefined()
    await first.close()

    const second = new OrchestrationDaemon({
      root, dshHome: home, residentClient: resident as unknown as ResidentDaemonClient,
      modelWorkerProviders: [], browserProviderModules: [browserProviderModule], schedulerIntervalMs: 10,
    })
    await second.start()
    cleanup.push(async () => { await second.close(); await rm(home, { recursive: true, force: true }) })
    const recovered = await eventually(() => client.inspect(String(started.runId)), value => value.nodes[0]?.state === 'running')
    expect(recovered.nodes[0]?.state).toBe('running')
    const rebound = await callBrowserTool(originalBridge!)
    expect(rebound).toMatchObject({ isError: false })
    expect(second.store.readEvents(String(started.runId), 0, 500).events.map(value => value.type)).toContain('browser.binding.rebound')
    resident.settle()
    const completed = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]?.state).toBe('passed')
    expect(resident.requests).toHaveLength(1)
  }, 30_000)

  it('uses the same owner-local endpoint across bridge instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-bridge-'))
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
    const ctx = { browser: { runPlan: async () => ({ version: 1, workspace: { id: 'fixture', lifecycle: 'active', control: 'agent' }, operations: [] }) } }
    const first = new BrowserModelToolBridge(ctx as never, root)
    const firstBinding = await first.bind('execution-1', new AbortController().signal)
    await first.dispose()
    const second = new BrowserModelToolBridge(ctx as never, root)
    const secondBinding = await second.bind('execution-1', new AbortController().signal)
    expect(secondBinding.descriptor.socketPath).toBe(firstBinding.descriptor.socketPath)
    expect(secondBinding.descriptor.sessionId).toBe(firstBinding.descriptor.sessionId)
    secondBinding.release()
    await second.dispose()
  })
})
