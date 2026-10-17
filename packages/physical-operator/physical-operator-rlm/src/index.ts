/** Standalone RLM adapter over the existing orchestration execution owner. @module @deepseek-ai/dsh-physical-operator-rlm */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import {
  PhysicalOperatorError, PhysicalOperatorId,
  type PhysicalOperator, type PhysicalOperatorDescriptor, type PhysicalOperatorExecutionMode,
  type PhysicalOperatorProviderStartRequest, type PhysicalOperatorStartRequest,
  type PhysicalOperatorProviderRun, type PhysicalOperatorResult, type PhysicalOperatorProgressEvent,
} from '@deepseek-ai/dsh-physical-operator'
import { StandaloneRlmStartRejected, type OrchestrationNodeSpecV1, type StandaloneRlmCommandSnapshot, type StandaloneRlmStartRequest } from '@deepseek-ai/dsh-orchestration'
import { parseOperatorContextEnvelope, receiveOperatorContextEnvelope, renderOperatorContextEnvelopeText } from '@deepseek-ai/dsh-system-prompt'

export const name = 'physical-operator-rlm'
export const inject = ['physicalOperators', 'orchestrations', 'agents']

/** Explicit deployment settings; model and scope authority comes only from a registered Host policy. */
export interface Config {
  /** Stable outer wrapper id; the daemon exclusion manifest must contain the same value. */
  readonly id: string
  /** Operator name shown in model-visible discovery. */
  readonly displayName: string
  /** Deployment-owned description of the bounded analysis capability. */
  readonly description: string
  /** Maximum simultaneously held outer executions, including unresolved physical effects. */
  readonly maxConcurrency: number
  /** Positive interval in milliseconds between observations of the same accepted command. */
  readonly pollIntervalMs: number
}

/** Loader validation for deployment-owned settings. */
export const Config: z<Config> = z.object({
  id: z.string().required(), displayName: z.string().required(), description: z.string().required(),
  maxConcurrency: z.number().step(1).min(1).required(), pollIntervalMs: z.number().step(1).min(1).required(),
})

/** Upper bounds supplied explicitly by the embedding Host, never by tool JSON. */
export interface StandaloneRlmRootPolicy {
  /** Non-empty policy revision bound to each prepared tool call. */
  readonly version: string
  /** Concrete bottom execution operator and model; no wrapper or automatic fallback. */
  readonly driver: StandaloneRlmStartRequest['input']['driver']
  /** Host-approved read scopes passed into the certified single-leaf graph. */
  readonly readScopes: readonly string[]
  /** Context-packet budget in tokens for this analysis. */
  readonly contextMaxTokens: number
  /** Explicit enabled recursion, child and turn ceilings. */
  readonly rlm: NonNullable<OrchestrationNodeSpecV1['rlm']>
  /** Business retry policy; physically unknown outcomes remain indeterminate instead. */
  readonly retryPolicy: OrchestrationNodeSpecV1['retryPolicy']
}

/** Host registration capability published only by an active, registered wrapper instance. */
export interface StandaloneRlmHostBinding {
  readonly operatorId: PhysicalOperatorId
  /**
   * Bind the exact root returned by this embedding Host.
   * @param host - lifecycle owning the explicit grant.
   * @param agent - exact live top-level Agent instance.
   * @param policy - explicit versioned driver, scope and execution limits.
   * @returns disposer that revokes this grant.
   */
  registerRoot(host: Context, agent: Agent, policy: StandaloneRlmRootPolicy): () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Instance-specific registration readiness; discovery alone grants no eligibility. */
    standaloneRlmHost: StandaloneRlmHostBinding
  }
}

interface Grant {
  readonly agent: Agent
  readonly policy: StandaloneRlmRootPolicy
  readonly revoked: AbortController
}

interface Binding {
  readonly grant: Grant
  readonly signal: AbortSignal
  readonly toolCallId: string
  readonly fingerprint: string
  readonly request: StandaloneRlmStartRequest
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function fingerprint(request: PhysicalOperatorStartRequest): string {
  if ((request.mode ?? 'ephemeral') !== 'ephemeral'
    || request.systemPrompt !== undefined || request.residentLaneId !== undefined
    || request.modelToolBridge !== undefined || request.workspaceSnapshotInput !== undefined
    || request.workspaceMutationReturn !== undefined || request.nativeToolPolicy !== undefined
    || request.governedWorkspacePolicy !== undefined || request.generationLimits !== undefined
    || request.residentProfile !== undefined) {
    throw new PhysicalOperatorError('standalone first slice supports only text ephemeral tool input without native fields or generation overrides', 'OPERATOR_MODE_UNSUPPORTED')
  }
  if (request.executionId === undefined || request.prompt.length === 0
    || request.prompt.some(block => block.type !== 'text')) {
    throw new PhysicalOperatorError('standalone RLM requires a stable execution id and text blocks', 'INVALID_RESULT')
  }
  const envelope = request.contextEnvelope === undefined ? undefined : parseOperatorContextEnvelope(request.contextEnvelope)
  const blocks = request.prompt.map((block) => {
    if (block.type !== 'text') throw new PhysicalOperatorError('standalone text input required', 'INVALID_RESULT')
    return { type: 'text' as const, text: block.text }
  })
  if (envelope !== undefined && JSON.stringify(envelope.task) !== JSON.stringify(blocks)) {
    throw new PhysicalOperatorError('standalone envelope task differs from the original prompt', 'INVALID_RESULT')
  }
  return createHash('sha256').update(JSON.stringify({
    executionId: request.executionId, mode: 'ephemeral', label: request.label,
    prompt: blocks, contextEnvelope: envelope, parentId: request.parent.id,
  })).digest('hex')
}

class StandaloneRlmPhysicalOperator implements PhysicalOperator {
  readonly descriptor: PhysicalOperatorDescriptor
  private readonly grants = new WeakMap<Agent, Grant>()
  private readonly liveGrants = new Set<Grant>()
  private readonly bindings = new Map<string, Binding>()

  constructor(private readonly ctx: Context, private readonly config: Config) {
    for (const value of [config.id, config.displayName, config.description]) {
      if (value.trim() !== value || value.length === 0) throw new Error('standalone RLM configuration requires non-empty trimmed identities and descriptions')
    }
    if (![config.maxConcurrency, config.pollIntervalMs].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('standalone RLM capacity and poll interval must be explicit positive integers')
    }
    this.descriptor = Object.freeze({
      id: PhysicalOperatorId(config.id), displayName: config.displayName, description: config.description,
      maxConcurrency: config.maxConcurrency, tags: ['rlm', 'text-only'], executionModes: ['ephemeral'] as const,
    })
  }

  availability(mode?: PhysicalOperatorExecutionMode) {
    if (mode === 'resident') return { available: false as const, reason: 'standalone RLM outer lifetime is ephemeral-only' }
    return this.ctx.orchestrations.standaloneRlm === undefined
      ? { available: false as const, reason: 'orchestration Provider has no standalone execution owner' }
      : { available: true as const }
  }

  registerRoot(host: Context, agent: Agent, policy: StandaloneRlmRootPolicy): () => Promise<void> {
    if (this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new Error('standalone Host registration requires its exact live top-level Agent')
    }
    if (policy.version.length === 0 || policy.rlm.mode !== 'enabled') throw new Error('standalone Host policy requires an explicit version and enabled RLM limits')
    const fixed = freeze(structuredClone(policy))
    const grant: Grant = { agent, policy: fixed, revoked: new AbortController() }
    return host.effect(() => {
      const previous = this.grants.get(agent)
      previous?.revoked.abort(new Error('standalone Host policy replaced'))
      if (previous !== undefined) this.liveGrants.delete(previous)
      this.grants.set(agent, grant)
      this.liveGrants.add(grant)
      return () => {
        if (this.grants.get(agent) === grant) this.grants.delete(agent)
        this.liveGrants.delete(grant)
        grant.revoked.abort(new Error('standalone Host policy revoked'))
      }
    }, 'standaloneRlm.registerStandaloneRoot()')
  }

  revokeAll(): void {
    for (const grant of this.liveGrants) {
      if (this.grants.get(grant.agent) === grant) this.grants.delete(grant.agent)
      grant.revoked.abort(new Error('standalone Provider disposed'))
    }
    this.liveGrants.clear()
  }

  prepareToolCall(request: PhysicalOperatorStartRequest, toolCallId: string): void {
    const grant = this.grants.get(request.parent)
    if (grant === undefined) throw new Error('standalone RLM caller has no explicit Host registration')
    const digest = fingerprint(request)
    const executionId = request.executionId
    if (executionId === undefined) throw new Error('standalone RLM requires a stable execution id')
    this.assertGrant(grant, request.parent, request.signal)
    if (toolCallId.length === 0 || (request.contextEnvelope !== undefined
      && (request.contextEnvelope.source.kind !== 'tool' || request.contextEnvelope.source.toolCallId !== toolCallId))) {
      throw new Error('standalone RLM binding requires the exact physical_operator tool call')
    }
    const input: StandaloneRlmStartRequest['input'] = {
      version: 1, operatorId: this.descriptor.id, executionId,
      ...request.label === undefined ? {} : { label: request.label },
      prompt: structuredClone(request.prompt),
      ...request.contextEnvelope === undefined ? {} : { contextEnvelope: parseOperatorContextEnvelope(request.contextEnvelope) },
      driver: grant.policy.driver,
    }
    const task = input.contextEnvelope === undefined
      ? input.prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
      : renderOperatorContextEnvelopeText(input.contextEnvelope)
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) throw new Error('standalone registered Agent has no workspace')
    const compile: StandaloneRlmStartRequest['compile'] = {
      intent: { request: task },
      graph: {
        version: 1, title: request.label ?? this.descriptor.displayName, workspace, maxParallel: 1, risk: 'low', workspaceIsolation: 'shared',
        nodes: [{
          id: 'standalone', title: request.label ?? this.descriptor.displayName, role: 'bounded RLM analysis', task,
          dependsOn: [], requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
          contextPolicy: { maxTokens: grant.policy.contextMaxTokens, allowedSourceKinds: ['intent', 'artifact'], unavailableSource: 'block' },
          effectBudget: { read: [...grant.policy.readScopes], write: [], execute: [], network: [], cost: [], risk: [] },
          readScopes: [...grant.policy.readScopes], writeScopes: [], approvedSecretRefs: [],
          acceptance: [{ id: 'completed', kind: 'operator-completed', description: 'the existing RLM execution owner completes the requested task' }],
          rlm: grant.policy.rlm, retryPolicy: grant.policy.retryPolicy,
          operator: {
            preferredIds: [grant.policy.driver.operatorId], fallbackIds: [],
            profile: { model: grant.policy.driver.model,
              ...grant.policy.driver.kind !== 'resident' || grant.policy.driver.effort === undefined ? {} : { effort: grant.policy.driver.effort } },
          },
        }],
      },
    }
    const fixed = freeze(structuredClone({ input, compile }))
    const id = String(input.executionId)
    const previous = this.bindings.get(id)
    if (previous !== undefined && (previous.grant !== grant || previous.toolCallId !== toolCallId || previous.fingerprint !== digest)) {
      throw new Error('standalone tool execution id is already bound to another immutable input')
    }
    this.bindings.set(id, { grant, signal: request.signal, toolCallId, fingerprint: digest, request: fixed })
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const binding = this.bindings.get(String(request.executionId))
    if (binding === undefined || binding.fingerprint !== fingerprint(request) || binding.signal !== request.signal
      || binding.grant.agent !== request.parent) throw new Error('standalone RLM start has no matching prepared tool input')
    this.assertGrant(binding.grant, request.parent, request.signal)
    const control = this.ctx.orchestrations.standaloneRlm
    if (control === undefined) throw new Error('standalone RLM requires a supporting orchestration Provider')
    const ids = await control.operatorIds()
    this.assertGrant(binding.grant, request.parent, request.signal)
    if (!ids.includes(this.descriptor.id)) throw new Error('standalone wrapper id is absent from the daemon exclusion manifest')
    this.bindings.delete(String(request.executionId))
    const outcome = Promise.withResolvers<PhysicalOperatorResult>()
    const cancelled = new AbortController()
    const signal = AbortSignal.any([request.signal, binding.grant.revoked.signal, cancelled.signal])
    const events: PhysicalOperatorProgressEvent[] = []
    let finished = false
    const isFinished = (): boolean => finished
    let sent = false
    let cancelSent = false
    let snapshot: StandaloneRlmCommandSnapshot | undefined
    const expectedSha256 = control.requestFingerprint(binding.request)
    const matchingSnapshot = (value: StandaloneRlmCommandSnapshot): StandaloneRlmCommandSnapshot => {
      if (value.executionId !== request.executionId || value.requestSha256 !== expectedSha256) {
        throw new StandaloneRlmStartRejected('standalone command belongs to another immutable input', 'COMMAND_CONFLICT')
      }
      return value
    }
    let lastProgress = ''
    const progress = (data: Readonly<Record<string, unknown>>): void => {
      const encoded = JSON.stringify(data)
      if (encoded === lastProgress) return
      lastProgress = encoded
      events.push({ sequence: events.length + 1, type: 'standalone-rlm.state', time: new Date().toISOString(), data })
    }
    const rejectUnaccepted = (error: unknown): void => {
      finished = true
      progress({ state: sent ? 'rejected' : 'not-sent', error: error instanceof Error ? error.message : String(error) })
      outcome.reject(error)
    }
    const advance = async (): Promise<void> => {
      void control.start(binding.request, () => {
        this.assertGrant(binding.grant, request.parent, signal)
        if (binding.fingerprint !== fingerprint(request)) throw new Error('standalone input changed before wire dispatch')
        sent = true
        progress({ state: 'sent', executionId: request.executionId })
      }).then((value) => {
        try { snapshot = matchingSnapshot(value) } catch (error) { rejectUnaccepted(error) }
      }, (error: unknown) => {
        if (!sent || error instanceof StandaloneRlmStartRejected) rejectUnaccepted(error)
        else progress({ state: 'unknown', executionId: request.executionId, error: error instanceof Error ? error.message : String(error) })
      })
      while (!isFinished()) {
        if (sent) {
          try {
            snapshot = matchingSnapshot(await control.inspect(request.executionId))
            if (isFinished()) break
            if (signal.aborted && !cancelSent) {
              cancelSent = true
              snapshot = matchingSnapshot(await control.cancel(request.executionId, expectedSha256))
            }
            progress({ state: snapshot.state, settlement: snapshot.settlement, phase: snapshot.phase,
              executionId: snapshot.executionId, runId: snapshot.run?.runId })
            if (snapshot.settlement === 'settled') {
              if (snapshot.result !== undefined) {
                finished = true
                outcome.resolve(snapshot.result)
              } else if (snapshot.error !== undefined) {
                finished = true
                outcome.reject(Object.assign(new Error(snapshot.error.message), { code: snapshot.error.code }))
              } else throw new Error('settled standalone command has neither output nor an error')
            }
          } catch (error) {
            if (error instanceof StandaloneRlmStartRejected) rejectUnaccepted(error)
            else progress({ state: 'unknown', executionId: request.executionId, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (!isFinished()) await new Promise<void>((resolve) => { setTimeout(resolve, this.config.pollIntervalMs) })
      }
    }
    progress({ state: 'prepared', executionId: request.executionId })
    // Publish the handle and immediate materialization receipt before any asynchronous business command.
    setImmediate(() => { void advance().catch((error: unknown) => {
      if (!sent) rejectUnaccepted(error)
      else progress({ state: 'unknown', executionId: request.executionId, error: error instanceof Error ? error.message : String(error) })
    }) })
    return {
      ...binding.request.input.contextEnvelope === undefined ? {} : {
        contextReceipt: receiveOperatorContextEnvelope(binding.request.input.contextEnvelope, String(this.descriptor.id), 'text'),
      },
      result: outcome.promise,
      readEvents: (afterSequence, limit) => Promise.resolve({
        events: events.filter(event => event.sequence > afterSequence).slice(0, limit),
        nextSequence: events.filter(event => event.sequence > afterSequence).slice(0, limit).at(-1)?.sequence ?? afterSequence,
      }),
      dispose: async () => {
        cancelled.abort(new Error('standalone caller disposed'))
        await outcome.promise.then(() => {}, () => {})
      },
    }
  }

  private assertGrant(grant: Grant, agent: Agent, signal: AbortSignal): void {
    if (signal.aborted || grant.revoked.signal.aborted || this.grants.get(agent) !== grant
      || this.ctx.physicalOperators.getOperator(this.descriptor.id) !== this
      || this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new Error('standalone Host registration is revoked or no longer matches the exact live root')
    }
  }
}

/**
 * Register one exact Agent returned by the embedding Host's successful create/resume.
 * @param ctx - trusted Host effect owner, with the same physical operator and Agent registries.
 * @param operatorId - explicitly configured standalone wrapper identity.
 * @param agent - exact live AgentHandle.agent; ids or synthetic parents cannot substitute.
 * @param policy - versioned deployment scopes, limits and concrete driver selection.
 * @returns effect disposer that revokes pending sends and requests cancellation of accepted work.
 */
export function registerStandaloneRoot(
  ctx: Context, operatorId: string, agent: Agent, policy: StandaloneRlmRootPolicy,
): () => Promise<void> {
  const binding = ctx.get('standaloneRlmHost')
  if (binding === undefined || binding.operatorId !== operatorId) throw new Error('standalone Host binding is unavailable for operator: ' + operatorId)
  return binding.registerRoot(ctx, agent, policy)
}

/** Register the wrapper; no Agent becomes eligible until its trusted Host explicitly registers it. */
export function apply(ctx: Context, config: Config): void {
  const operator = new StandaloneRlmPhysicalOperator(ctx, config)
  let live = true
  ctx.effect(function* () {
    yield ctx.physicalOperators.registerOperator(operator)
    yield ctx.provide('standaloneRlmHost', {
      operatorId: operator.descriptor.id,
      registerRoot: (host, agent, policy) => {
        if (!live) throw new Error('standalone Host binding has been withdrawn')
        return operator.registerRoot(host, agent, policy)
      },
    })
    // Close admission and revoke grants before withdrawing the capability and registration.
    yield () => { live = false; operator.revokeAll() }
  }, 'standaloneRlm.registerProviderAndHostBinding()')
}
