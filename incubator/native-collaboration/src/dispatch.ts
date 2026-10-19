import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GraphStatus, ModelCatalog, ResidentApi, TaskGraph } from '@lisihao/dsh-solar-native-resident/contracts'
import {
  labelForTask,
  normalizeCollaborationInput,
  renderHandoff,
  toTaskScope,
  normalizeDshTools,
  type NormalizedCollaborationInput,
} from './validation.js'

// Keep the optional Resident bundle out of the one-shot module's runtime
// dependency graph. These values are locked to the type-only protocol contract.
const RESIDENT_PROTOCOL_VERSION = 1
const RESIDENT_SERVICE = 'solarNativeResident'

type ResidentBridgeApi = Omit<ResidentApi, 'bindBridge'> & {
  bindBridge?: (bridgeId: string, owner: ToolRunContext, allowedTools?: readonly string[]) => Promise<void>
  models?: (cwd: string) => Promise<readonly ModelCatalog[]>
}

export interface DelegationOutput {
  readonly kind: 'activation' | 'resident-graph'
  readonly executor: NormalizedCollaborationInput['executor']
  readonly mode: NormalizedCollaborationInput['mode']
  readonly handoff: string
  readonly childId?: string
  readonly graphId?: string
  readonly status?: GraphStatus
  readonly revision?: number
}

export interface DelegationServices {
  readonly subagents: Pick<SubagentRuntime, 'startActivation'>
  readonly resident: () => ResidentBridgeApi | undefined
  readonly trackActivation: (activation: SubagentActivation) => void
}

/** Dispatch one validated handoff through either the official one-shot seam or Resident. */
export async function dispatchCollaboration(
  rawInput: unknown,
  exec: ToolRunContext,
  services: DelegationServices,
  providerFor: (executor: NormalizedCollaborationInput['executor']) => string,
): Promise<DelegationOutput> {
  const input = normalizeCollaborationInput(rawInput)
  exec.signal.throwIfAborted()
  const handoff = renderHandoff(input)
  const callId = String(exec.callId).trim()
  if (!callId) throw new Error('solar_delegate requires a stable tool call id')
  const commandId = `native-collaboration:${callId}`

  if (input.mode === 'single') {
    const parent = exec.agent
    if (parent === undefined) {
      throw new Error('solar_delegate single mode requires the calling Agent (exec.agent was undefined)')
    }
    const activation = await services.subagents.startActivation({
      provider: providerFor(input.executor),
      label: labelForTask(input.task),
      request: {
        parent,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        prompt: [{ type: 'text', text: handoff }],
      },
      signal: exec.signal,
      delivery: 'parent',
    })
    services.trackActivation(activation)
    return {
      kind: 'activation',
      executor: input.executor,
      mode: input.mode,
      handoff,
      childId: String(activation.childId),
    }
  }

  const resident = services.resident()
  if (resident === undefined) {
    throw new Error(
      `solar_delegate resident mode requires the ${RESIDENT_SERVICE} service; install and enable the native-resident plugin`,
    )
  }
  if (resident.protocolVersion !== RESIDENT_PROTOCOL_VERSION || typeof resident.submit !== 'function') {
    throw new Error(
      `solar_delegate resident mode requires Resident protocol version ${RESIDENT_PROTOCOL_VERSION}`,
    )
  }

  // normalizeCollaborationInput requires cwd for this branch.
  const cwd = input.cwd
  if (cwd === undefined) {
    throw new Error('solar_delegate resident mode requires an explicit cwd for the durable graph')
  }
  const dshTools = normalizeDshTools(input.dshTools)
  const bridgeId = dshTools === undefined ? undefined : `${commandId}:bridge`
  if (bridgeId !== undefined) {
    if (resident.bindBridge === undefined) {
      throw new Error('solar_delegate resident mode with dsh_tools requires the Resident bindBridge capability')
    }
    if (exec.agent === undefined) {
      throw new Error('solar_delegate resident mode with dsh_tools requires the calling Agent for DSH tool bridge ownership')
    }
    await resident.bindBridge(bridgeId, exec, dshTools)
  }
  const profile = input.profile === undefined ? undefined : {
    ...(input.profile.model === undefined ? {} : { model: input.profile.model }),
    ...(input.profile.reasoningEffort === undefined ? {} : { reasoningEffort: input.profile.reasoningEffort }),
  }
  const taskScope = toTaskScope(input.scope)
  const graph: TaskGraph = {
    formatVersion: 1,
    id: `${commandId}:graph`,
    label: `Solar native collaboration: ${labelForTask(input.task)}`,
    cwd,
    maxParallel: 1,
    ...(bridgeId === undefined ? {} : { bridgeId }),
    nodes: [
      {
        id: 'delegate',
        executor: input.executor,
        prompt: handoff,
        ...(taskScope === undefined ? {} : { scope: taskScope }),
        ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
        ...(profile === undefined ? {} : { profile }),
      },
    ],
  }
  const snapshot = await resident.submit({ commandId, graph })
  return {
    kind: 'resident-graph',
    executor: input.executor,
    mode: input.mode,
    handoff,
    graphId: snapshot.graph.id,
    status: snapshot.status,
    revision: snapshot.revision,
  }
}
