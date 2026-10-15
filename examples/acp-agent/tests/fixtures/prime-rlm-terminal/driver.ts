#!/usr/bin/env node
/**
 * Emit a keyless transcript of the terminal state of an RLM run whose message continuation or root did not succeed.
 *
 * Composition: the production app boot and YAML Loader assemble the orchestration client service (`autoStart: false`),
 * and every run is driven through that service. The daemon is constructed here, as in the kennel-ai-dispatch fixture,
 * because the production daemon takes its model worker from DeepSeek credentials and has no seam for a keyless one. The
 * daemon gets a keyless API worker and no Resident operator, so the real client protocol, the real model-tool bridge, and the
 * real RLM runtime run without a network or an API key.
 */

import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { ModelWorkerExecuteRequest, ModelWorkerProvider, ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { OrchestrationDaemon } from '@deepseek-ai/dsh-orchestration-local'
import type { LogicalTaskGraphV1, OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) {
  throw new Error('prime-rlm-terminal fixture requires a config path and an isolated DSH_HOME')
}

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

/** What one scenario does to the shared keyless worker, and how the driver triggers it once the run has started. */
interface Scenario {
  readonly name: string
  readonly autonomous: boolean
  readonly script: (request: ModelWorkerExecuteRequest, gates: Gates) => Promise<ModelWorkerResult | undefined>
  readonly trigger?: (stage: Stage, worker: KeylessWorker, gates: Gates) => Promise<void>
}

/** Waits for one named condition and fails with the stage and the last observed state, never silently. */
type Stage = (name: string, ready: () => boolean | Promise<boolean>, observed: () => string) => Promise<void>

// The outer launcher kills a smoke after 30 s. Each stage gets 5 s and a whole scenario 10 s, so the two scenarios and the
// boot fit inside that limit with the failure reported by this driver, not by the launcher.
const STAGE_MS = 5_000
const SCENARIO_MS = 10_000

let current: Scenario | undefined
let currentGates: Gates | undefined
const worker = new KeylessWorker(request => (current === undefined || currentGates === undefined
  ? Promise.resolve(undefined)
  : current.script(request, currentGates)))
const daemon = new OrchestrationDaemon({
  root: join(home, 'orchestrations'), dshHome: home, residentClient: noResident, modelWorkerProviders: [worker],
  schedulerIntervalMs: 10, autonomousEndConditionEvaluators: { quality: () => 'pass' as const },
})
await daemon.start()
const ctx = await boot('prime-rlm-terminal-keyless', resolveConfigPath(configPath, undefined))
const orchestration = ctx.orchestrations

async function run(scenario: Scenario) {
  const workspace = join(home as string, `workspace-${scenario.name}`)
  await mkdir(workspace, { recursive: true })
  const gates: Gates = { child: Promise.withResolvers<undefined>(), continuation: Promise.withResolvers<undefined>() }
  current = scenario
  currentGates = gates
  const first = worker.requests.length
  const mine = (): ModelWorkerExecuteRequest[] => worker.requests.slice(first)
  const requestIds = (): string => JSON.stringify(mine().map(request => request.commandId.replace(/^.*?:rlm:/u, 'rlm:')))
  // The scenario deadline starts before the run does, so a stage that never happens cannot outlast it.
  const scenarioLimit = Date.now() + SCENARIO_MS
  const progress: { runId?: OrchestrationRunId } = {}
  const stage: Stage = async (name, ready, observed) => {
    const limit = Math.min(Date.now() + STAGE_MS, scenarioLimit)
    while (!await ready()) {
      if (Date.now() >= limit) {
        const snapshot = progress.runId === undefined ? undefined : await orchestration.inspect(progress.runId)
        const runState = snapshot === undefined ? 'not started' : `${snapshot.state}, node ${String(snapshot.nodes[0]?.state)}`
        throw new Error(`${scenario.name}: stage "${name}" did not happen in time; worker requests ${observed()}; run ${runState}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const compilation = await orchestration.compile({
    intent: { request: scenario.name },
    admission: {
      policy: 'codex', route: 'taskgraph', sourceSessionId: scenario.name, rlm: 'enabled', continualHarness: 'off', optimization: 'balanced',
    },
    graph: graph(workspace, scenario.autonomous),
  })
  const started = await orchestration.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
  progress.runId = started.runId
  await scenario.trigger?.(stage, worker, gates)
  let state = await orchestration.inspect(started.runId)
  await stage('settle', async () => {
    state = await orchestration.inspect(started.runId)
    return ['completed', 'failed'].includes(state.state)
  }, requestIds)
  const events = (await orchestration.readEvents({ runId: started.runId, limit: 400 })).events
  return {
    run: state.state,
    node: state.nodes[0]?.state,
    stopReasons: events.filter(event => event.type === 'rlm.execution.settled').map(event => event.data.stopReason),
    continuations: events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => event.type),
    laterTurnsStarted: mine()
      .filter(request => /:(goal|autonomous)-continuation:/u.test(request.commandId))
      .map(request => request.commandId.replace(/^.*:(goal|autonomous)-continuation:/u, '$1 continuation ')),
  }
}

try {
  // The root completes, a child's parent message makes the daemon continue the root, that continuation stops with max-tokens,
  // and the root has an active goal whose next turn would succeed.
  const goal = await run({
    name: 'goal-after-failed-message',
    autonomous: false,
    script: async (request, gates) => {
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
    },
    trigger: async (stage, keyless, gates) => {
      const seen = (suffix: string) => () => keyless.requests.some(request => request.commandId.endsWith(suffix))
      const observed = () => JSON.stringify(keyless.requests.map(request => request.commandId.replace(/^.*?:rlm:/u, 'rlm:')))
      await stage('root started', seen(':rlm:root'), observed)
      gates.child.resolve(undefined)
      await stage('message continuation requested', seen(':deliver'), observed)
      gates.continuation.resolve(undefined)
    },
  })

  // Autonomous Mode with an end condition that a later turn would satisfy, after a root that stopped with refusal.
  const autonomous = await run({
    name: 'autonomous-after-refusal',
    autonomous: true,
    script: request => Promise.resolve(
      request.commandId.endsWith(':rlm:root') ? { output: [{ type: 'text', text: 'partial root' }], stopReason: 'refusal' } : undefined,
    ),
  })

  process.stdout.write(`${JSON.stringify({ goal, autonomous }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
  await daemon.close()
}
