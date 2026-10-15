#!/usr/bin/env node
/**
 * Emit a keyless transcript of the terminal state of an RLM run whose message continuation or root did not succeed.
 * It boots the orchestration daemon with a keyless API worker (no Resident operator, no network) and drives it through
 * the real client, the real model-tool bridge, and the real RLM runtime.
 */

import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { ModelWorkerExecuteRequest, ModelWorkerProvider, ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import { OrchestrationDaemon, OrchestrationDaemonClient } from '@deepseek-ai/dsh-orchestration-local'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

const home = process.env.DSH_HOME
if (home === undefined) throw new Error('prime-rlm-terminal fixture requires an isolated DSH_HOME')

/** A Resident daemon with no operator: the keyless run only reaches the API worker. */
const noResident = {
  providers: () => Promise.resolve([]),
  list: () => Promise.resolve([]),
  interrupt: () => Promise.resolve(),
} as unknown as ResidentDaemonClient

async function callTool(request: ModelWorkerExecuteRequest, commandId: string, code: string): Promise<void> {
  const bridge = request.modelToolBridge
  if (bridge === undefined) throw new Error('fixture expected a model-tool bridge')
  const socket = createConnection(bridge.socketPath)
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    await transport.request('tool.call', { session_id: bridge.sessionId, command_id: commandId, tool: 'typescript_repl', arguments: { code } })
  } finally {
    transport.close()
    socket.destroy()
  }
}

class KeylessWorker implements ModelWorkerProvider {
  readonly id = 'deepseek-keyless-fixture'
  readonly requests: ModelWorkerExecuteRequest[] = []
  readonly script: (request: ModelWorkerExecuteRequest) => Promise<ModelWorkerResult | undefined>

  constructor(script: (request: ModelWorkerExecuteRequest) => Promise<ModelWorkerResult | undefined>) {
    this.script = script
  }

  offers() {
    const common = {
      operatorId: this.id, provider: 'deepseek-official-fixture', displayName: 'Keyless DeepSeek fixture',
      source: 'metered-api' as const, available: true, maxConcurrency: 8, activeCount: 0, tags: ['api', 'offline-fixture'],
    }
    return Promise.resolve([
      { ...common, offerId: `000-${this.id}:fixture-high`, model: 'deepseek-fixture-high', tier: 'high' as const },
      { ...common, offerId: `000-${this.id}:fixture-low`, model: 'deepseek-fixture-low', tier: 'low' as const },
    ])
  }

  async execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    this.requests.push(request)
    return await this.script(request) ?? { output: [{ type: 'text', text: `completed ${request.commandId}` }], stopReason: 'completed' }
  }
}

function graph(workspace: string, autonomous: boolean): LogicalTaskGraphV1 {
  return {
    version: 1, title: 'keyless terminal graph', workspace, maxParallel: 1, risk: 'low',
    nodes: [{
      id: 'rlm', title: 'Recursive node', task: 'Run one recursive node.', role: 'recursive synthesis', dependsOn: [],
      requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      approvedSecretRefs: [], readScopes: ['src'], writeScopes: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      ...autonomous
        ? {
          rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
          autonomous: {
            mode: 'enabled', maxContinuations: 2,
            endCondition: { version: 1, operator: 'all', checks: [
              { id: 'completed', kind: 'acceptance', ref: 'done' }, { id: 'quality', kind: 'evaluator', ref: 'quality' },
            ] },
          },
        }
        : {},
    }],
  }
}

/** Points where the script holds the child and the message continuation until the driver releases them. */
interface Gates {
  readonly child: PromiseWithResolvers<undefined>
  readonly continuation: PromiseWithResolvers<undefined>
}

async function scenario(
  name: string,
  autonomous: boolean,
  script: (request: ModelWorkerExecuteRequest, gates: Gates) => Promise<ModelWorkerResult | undefined>,
  trigger?: (worker: KeylessWorker, gates: Gates) => Promise<void>,
) {
  const dir = join(home as string, name)
  await mkdir(join(dir, 'workspace'), { recursive: true })
  const gates = { child: Promise.withResolvers<undefined>(), continuation: Promise.withResolvers<undefined>() }
  const worker = new KeylessWorker(request => script(request, gates))
  const root = join(dir, 'orchestrations')
  const daemon = new OrchestrationDaemon({
    root, dshHome: dir, residentClient: noResident, modelWorkerProviders: [worker], schedulerIntervalMs: 10,
    autonomousEndConditionEvaluators: { quality: () => 'pass' as const },
  })
  await daemon.start()
  try {
    const client = new OrchestrationDaemonClient({ root, dshHome: dir, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({
      intent: { request: name },
      admission: { policy: 'codex', route: 'taskgraph', sourceSessionId: name, rlm: 'enabled', continualHarness: 'off', optimization: 'balanced' },
      graph: graph(join(dir, 'workspace'), autonomous),
    })
    const run = await client.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
    await trigger?.(worker, gates)
    const deadline = Date.now() + 10_000
    for (;;) {
      const state = await client.inspect(String(run.runId))
      if (['completed', 'failed'].includes(state.state)) {
        const events = (await client.readEvents({ runId: run.runId, limit: 400 })).events
        return {
          run: state.state,
          node: state.nodes[0]?.state,
          stopReasons: events.filter(event => event.type === 'rlm.execution.settled').map(event => event.data.stopReason),
          continuations: events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => event.type),
          laterTurnsStarted: worker.requests
            .filter(request => /:(goal|autonomous)-continuation:/u.test(request.commandId))
            .map(request => request.commandId.replace(/^.*:(goal|autonomous)-continuation:/u, '$1 continuation ')),
        }
      }
      if (Date.now() >= deadline) throw new Error(`${name} did not settle: ${JSON.stringify(state)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  } finally {
    await daemon.close()
  }
}

// The root completes, a child's parent message makes the daemon continue the root, that continuation stops with max-tokens,
// and the root has an active goal whose next turn would succeed.
const goal = await scenario('goal-after-failed-message', false, async (request, gates) => {
  if (request.commandId.endsWith(':rlm:root')) {
    await callTool(request, 'goal-spawn', 'await rlm("child evidence", { name: "evidence" }); "spawned"')
    await callTool(request, 'goal-create', 'await goal.create("finish the objective", { continuationBudget: 2 }); "goal active"')
    return undefined
  }
  if (request.commandId.includes(':goal-continuation:')) {
    await callTool(request, 'goal-complete', 'await goal.complete(); "goal complete"')
    return undefined
  }
  if (request.commandId.endsWith(':deliver')) {
    await gates.continuation.promise
    return { output: [{ type: 'text', text: 'partial continuation' }], stopReason: 'max-tokens' }
  }
  await gates.child.promise
  await callTool(request, 'goal-send', 'await agentMessage.send("child evidence", { receiverRole: "parent", mode: "auto" }); "sent"')
  return undefined
}, async (worker, gates) => {
  const rootDone = async () => worker.requests.some(request => request.commandId.endsWith(':rlm:root'))
  while (!await rootDone()) await new Promise(resolve => setTimeout(resolve, 10))
  gates.child.resolve(undefined)
  while (!worker.requests.some(request => request.commandId.endsWith(':deliver'))) await new Promise(resolve => setTimeout(resolve, 10))
  gates.continuation.resolve(undefined)
})

// Autonomous Mode with an end condition that a later turn would satisfy, after a root that stopped with refusal.
const autonomous = await scenario('autonomous-after-refusal', true, request => Promise.resolve(
  request.commandId.endsWith(':rlm:root') ? { output: [{ type: 'text', text: 'partial root' }], stopReason: 'refusal' } : undefined,
))

process.stdout.write(`${JSON.stringify({ goal, autonomous }, null, 2)}\n`)
