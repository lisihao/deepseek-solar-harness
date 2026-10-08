/** Remote Resident Provider over the authenticated DSH Server control plane. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
const execGit = promisify(execFile)
import {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorAcceptedReceipt,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import {
  parseRemoteResidentResult, RemoteResidentCapabilityError,
  type RemoteResidentAcceptedTurn,
  type RemoteResidentExecuteRequest,
  type RemoteResidentProviderStatus,
  type RemoteResidentTurnSnapshot,
  type RemoteExecutionWorkspaceIdentityV1,
} from '@deepseek-ai/dsh-client-connection'
import type { GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'
import { residentProgressPage } from '@deepseek-ai/dsh-resident-operator'
import {
  RemoteSyncHttpClient,
  RemoteSyncRejectedError,
  RemoteSyncTransportError,
} from './remote-sync-http-client.ts'
import { abortableDelay } from './abortable-delay.ts'
import { identifyRemoteWorkspace } from './remote-execution-host.ts'

const REMOTE_ARTIFACT_TRANSFER_TIMEOUT_MS = 15_000
import type { OrchestrationStore } from './store.ts'

interface MutationTarget {
  readonly path: string
  readonly baseSha: string
  readonly identity: RemoteExecutionWorkspaceIdentityV1
}

const WORKSPACE_IDENTITY_TIMEOUT_MS = 10_000

type RemoteResultStore = Pick<
  OrchestrationStore,
  'root' | 'putArtifact' | 'readArtifact' | 'recordArtifact'
>

/** Binding that turns a remote Server into a Gouzi execution member. */
export interface RemotePhysicalOperatorGouzi {
  /** Stable member identity; the operator id becomes `gouzi.<gouziId>.<operatorId>`. */
  readonly gouziId: string
  /** Internal authority qualification for a local member at a verified loopback endpoint; never user configuration. */
  readonly allowLocalWorkspaceSnapshot?: true
  /**
   * Seal one attempt as an execution grant. Runs once per `start`, with the exact request that will be sent.
   * @param plan - the Resident execution request without a grant.
   * @param start - the Provider start request that carries the execution id.
   * @param workspace - freshly read member project and generation binding, required for directory execution.
   * @returns the grant the member verifies before any side effect.
   * @throws PhysicalOperatorError - when the member cannot be granted this attempt.
   */
  readonly issue: (plan: RemoteResidentExecuteRequest, start: PhysicalOperatorProviderStartRequest, workspace?: RemoteResidentProviderStatus['gouziWorkspace']) => GouziExecutionGrant
}

/** One independently addressable DSH Server execution member. */
export interface RemotePhysicalOperatorServer {
  /** Stable deployment id used to namespace Provider and quota identities. */
  readonly id: string
  readonly label: string
  readonly endpoint: string
  readonly accessToken?: string
  /** Settlement polling interval; defaults to 250ms. */
  readonly pollIntervalMs?: number
  /** Present when this Server is a Gouzi execution member. */
  readonly gouzi?: RemotePhysicalOperatorGouzi
}

function alias(server: RemotePhysicalOperatorServer, nativeOperatorId: string): string {
  const serverId = server.gouzi?.gouziId ?? server.id
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(serverId)) {
    throw new Error('remote physical operator server id must use lowercase letters, digits, dots, underscores, or hyphens')
  }
  return `${server.gouzi === undefined ? 'remote' : 'gouzi'}.${serverId}.${nativeOperatorId}`
}

/** One remote Server's native product projected through the Physical Operator seam. */
export class RemotePhysicalOperator implements PhysicalOperator {
  readonly descriptor
  private provider: RemoteResidentProviderStatus
  private readonly client: RemoteSyncHttpClient
  private unavailableReason: string | undefined

  constructor(
    readonly server: RemotePhysicalOperatorServer,
    provider: RemoteResidentProviderStatus,
    private readonly resultStore: RemoteResultStore,
    request: typeof fetch = globalThis.fetch,
  ) {
    this.provider = provider
    this.client = new RemoteSyncHttpClient(server.endpoint, server.accessToken, request)
    this.descriptor = {
      id: PhysicalOperatorId(alias(server, provider.operatorId)),
      displayName: `${provider.displayName} · ${server.label}`,
      description: `${provider.description} Remote execution on ${server.label}.`,
      tags: Object.freeze([
        ...provider.tags, 'remote', `server.${server.id}`,
        ...server.gouzi === undefined ? [] : ['gouzi', `gouzi.${server.gouzi.gouziId}`],
      ]),
      maxConcurrency: provider.maxConcurrency,
      executionModes: ['resident'] as const,
    }
  }

  availability() {
    return this.unavailableReason === undefined && this.provider.available
      ? { available: true as const }
      : {
        available: false as const,
        reason: this.unavailableReason ?? this.provider.unavailableReason ?? 'remote Provider unavailable',
      }
  }

  async residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    try {
      const current = (await this.client.operatorProviders())
        .find(value => value.operatorId === this.provider.operatorId)
      if (current === undefined) {
        this.unavailableReason = `remote Provider "${this.provider.operatorId}" disappeared from ${this.server.label}`
      } else {
        this.provider = current
        this.unavailableReason = undefined
      }
    } catch (error) {
      this.unavailableReason = `${this.server.label} qualification failed: ${renderError(error)}`
    }
    const current = this.provider
    return {
      operatorId: this.descriptor.id,
      product: current.product,
      injectionBoundaries: current.injectionBoundaries,
      supportsModelToolBridge: false,
      location: 'remote',
      supportsWorkspaceMutationReturn: current.supportsWorkspaceMutationReturn === true,
      supportsGovernedWorkspacePolicy: current.supportsGovernedWorkspacePolicy === true,
      supportsGenerationLimits: current.supportsGenerationLimits === true,
      available: current.available && this.unavailableReason === undefined,
      ...this.unavailableReason === undefined
        ? current.unavailableReason === undefined ? {} : { unavailableReason: current.unavailableReason }
        : { unavailableReason: this.unavailableReason },
      ...current.quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason: current.quotaUnavailableReason },
      authentication: current.authentication,
      productVersion: current.productVersion,
      protocolHash: current.protocolHash,
      models: current.models,
      ...this.server.gouzi === undefined || this.unavailableReason !== undefined || current.gouziWorkspace === undefined
        || current.gouziWorkspace.gouziId !== this.server.gouzi.gouziId ? {} : { gouziWorkspace: current.gouziWorkspace },
      ...current.quotaPools === undefined ? {} : {
        quotaPools: current.quotaPools.map(pool => ({
          ...pool,
          poolId: `remote.${this.server.id}.${pool.poolId}`,
        })),
      },
    }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (request.workspaceSnapshotInput !== undefined || request.workspaceMutationReturn?.baseBundle !== undefined) {
      const hostname = new URL(this.server.endpoint).hostname
      if (this.server.gouzi?.allowLocalWorkspaceSnapshot !== true
        || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
        throw new PhysicalOperatorError('complete workspace snapshots require an authority-qualified local member and loopback endpoint', 'WORKSPACE_INVALID')
      }
    }
    if (request.modelToolBridge !== undefined) {
      throw new PhysicalOperatorError(
        'remote physical operators do not expose an owner-local model-tool socket',
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    if (request.nativeToolPolicy === 'dsh-tools-authoritative' && request.governedWorkspacePolicy === undefined) {
      throw new PhysicalOperatorError(
        'remote physical operators cannot use an owner-local DSH tool bridge as authority',
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    let workspaceIdentity: RemoteExecutionWorkspaceIdentityV1
    let gouziWorkspace: RemoteResidentProviderStatus['gouziWorkspace']
    if (this.server.gouzi !== undefined) {
      let current: RemoteResidentProviderStatus | undefined
      try {
        current = (await this.client.operatorProviders(request.signal))
          .find(value => value.operatorId === this.provider.operatorId)
      } catch (cause) {
        throw new PhysicalOperatorError(
          `Gouzi project qualification failed on ${this.server.label}: ${renderError(cause)}`,
          'OPERATOR_UNAVAILABLE', { cause },
        )
      }
      gouziWorkspace = current?.gouziWorkspace
      if (current?.available !== true
        || (gouziWorkspace !== undefined && gouziWorkspace.gouziId !== this.server.gouzi.gouziId)) {
        throw new PhysicalOperatorError(
          `Gouzi ${this.server.label} has no qualified registered project`,
          'WORKSPACE_INVALID',
        )
      }
      this.provider = current
    }
    if (gouziWorkspace !== undefined) {
      workspaceIdentity = { version: 1, kind: 'gouzi-project', projectId: gouziWorkspace.projectId }
    } else {
      // A member provisioned with the existing Git allowlist retains exact-commit execution.
      const workspace = request.parent.session.header.cwd
      if (workspace === undefined) {
        throw new PhysicalOperatorError('remote physical operator requires a workspace', 'WORKSPACE_INVALID')
      }
      try {
        workspaceIdentity = await identifyRemoteWorkspace(workspace, WORKSPACE_IDENTITY_TIMEOUT_MS)
      } catch (cause) {
        throw new PhysicalOperatorError(
          `remote physical operator cannot reproduce workspace: ${renderError(cause)}`,
          'WORKSPACE_INVALID', { cause },
        )
      }
    }
    if (request.governedWorkspacePolicy !== undefined || request.generationLimits !== undefined) {
      const current = (await this.client.operatorProviders(request.signal)).find(value => value.operatorId === this.provider.operatorId)
      if (current === undefined
        || (request.governedWorkspacePolicy !== undefined && current.supportsGovernedWorkspacePolicy !== true)
        || (request.generationLimits !== undefined && current.supportsGenerationLimits !== true)) {
        throw new PhysicalOperatorError('remote Native driver does not support the requested governed file policy or generation limits', 'OPERATOR_MODE_UNSUPPORTED')
      }
      this.provider = current
    }
    let mutationTarget: MutationTarget | undefined
    if (request.workspaceMutationReturn !== undefined) {
      if (this.provider.supportsWorkspaceMutationReturn !== true) throw new PhysicalOperatorError('remote host cannot return workspace mutations', 'WORKSPACE_INVALID')
      const cwd = request.parent.session.header.cwd
      if (cwd === undefined) throw new PhysicalOperatorError('mutation requires caller execution workspace', 'WORKSPACE_INVALID')
      await verifyMutationTarget(cwd, request.workspaceMutationReturn.baseSha)
      mutationTarget = { path: cwd, baseSha: request.workspaceMutationReturn.baseSha, identity: workspaceIdentity }
    }
    const plan: RemoteResidentExecuteRequest = {
      ...request.workspaceSnapshotInput === undefined ? {} : { workspaceSnapshotInput: { version: 1, ...request.workspaceSnapshotInput } },
      ...request.workspaceMutationReturn === undefined
        ? {} : { workspaceMutationReturn: { version: 1, ...request.workspaceMutationReturn } },
      commandId: String(request.executionId),
      operatorId: this.provider.operatorId,
      workspaceIdentity,
      laneId: request.residentLaneId ?? String(request.executionId),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
      ...request.contextEnvelope === undefined ? {} : { contextEnvelope: request.contextEnvelope },
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
      ...request.nativeToolPolicy === undefined ? {} : { nativeToolPolicy: request.nativeToolPolicy },
      ...request.generationLimits === undefined ? {} : { generationLimits: request.generationLimits },
      ...request.governedWorkspacePolicy === undefined ? {} : { governedWorkspacePolicy: request.governedWorkspacePolicy },
    }
    const gouziGrant = this.server.gouzi?.issue(plan, request, gouziWorkspace)
    if (request.workspaceMutationReturn !== undefined) {
      await mkdir(join(this.resultStore.root, 'remote-mutation-targets'), { recursive: true, mode: 0o700 })
      try {
        await writeFile(this.mutationTargetPath(plan.commandId), JSON.stringify({ path: request.parent.session.header.cwd, baseSha: request.workspaceMutationReturn.baseSha, identity: workspaceIdentity }), { flag: 'wx', mode: 0o600 })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new PhysicalOperatorError('remote mutation command already has an unresolved local binding; reattach its original receipt', 'COMMAND_INDETERMINATE', { cause })
        throw cause
      }
    }
    let accepted: RemoteResidentAcceptedTurn
    try {
      accepted = await this.client.operatorExecute(
        gouziGrant === undefined ? plan : { ...plan, gouziGrant },
        request.signal,
      )
      this.unavailableReason = undefined
    } catch (error) {
      this.unavailableReason = `${this.server.label} admission failed: ${renderError(error)}`
      if (error instanceof RemoteResidentCapabilityError) {
        throw new PhysicalOperatorError(error.message, 'OPERATOR_MODE_UNSUPPORTED', { cause: error })
      }
      if (error instanceof RemoteSyncRejectedError) {
        throw new PhysicalOperatorError(error.message, 'OPERATOR_UNAVAILABLE', { cause: error })
      }
      // Once an HTTP command leaves this process, absence of a correlated
      // response cannot prove that the remote durable Receipt was not accepted.
      throw new PhysicalOperatorError(
        `remote command admission is indeterminate on ${this.server.label}: ${renderError(error)}`,
        'COMMAND_INDETERMINATE',
        { cause: error },
      )
    }
    if (request.contextEnvelope !== undefined) {
      const receipt = accepted.contextReceipt
      if (receipt === undefined) {
        throw new PhysicalOperatorError(
          `remote physical operator did not acknowledge context envelope ${request.contextEnvelope.digest}`,
          'CONTEXT_ENVELOPE_DROPPED',
        )
      }
      if (receipt.digest !== request.contextEnvelope.digest
        || receipt.receiver !== `remote-resident:${this.provider.operatorId}`) {
        throw new PhysicalOperatorError(
          `remote physical operator returned an invalid context receipt for ${request.contextEnvelope.digest}`,
          'CONTEXT_ENVELOPE_INVALID',
        )
      }
    }
    return this.observe(accepted, request.signal, mutationTarget)
  }

  async reattach(turnId: string): Promise<PhysicalOperatorProviderRun> {
    let turn: RemoteResidentTurnSnapshot
    try {
      turn = await this.client.operatorInspect(turnId)
    } catch (error) {
      this.unavailableReason = `${this.server.label} reattach failed: ${renderError(error)}`
      if (error instanceof RemoteSyncRejectedError && error.message.includes('SESSION_UNAVAILABLE')) {
        throw new PhysicalOperatorError(error.message, 'COMMAND_INDETERMINATE')
      }
      throw new PhysicalOperatorError(renderError(error), 'OPERATOR_UNAVAILABLE', { cause: error })
    }
    this.unavailableReason = undefined
    let target: MutationTarget | undefined
    try { target = parseMutationTarget(JSON.parse(await readFile(this.mutationTargetPath(turn.commandId), 'utf8')) as unknown) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return this.observe({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      stateRevision: turn.stateRevision,
    }, undefined, target)
  }

  private mutationTargetPath(commandId: string): string {
    return join(this.resultStore.root, 'remote-mutation-targets', createHash('sha256').update(`${this.server.id}\0${commandId}`).digest('hex'))
  }

  interrupt(receipt: PhysicalOperatorAcceptedReceipt): Promise<void> {
    return this.client.operatorInterrupt(receipt.sessionId, receipt.turnId)
  }

  private observe(
    accepted: RemoteResidentAcceptedTurn,
    executionSignal?: AbortSignal,
    mutationTarget?: MutationTarget,
  ): PhysicalOperatorProviderRun {
    const polling = new AbortController()
    const interrupt = (): void => {
      void this.client.operatorInterrupt(accepted.sessionId, accepted.turnId).catch(() => undefined)
    }
    executionSignal?.addEventListener('abort', interrupt, { once: true })
    if (executionSignal?.aborted === true) interrupt()

    const result = this.settle(accepted.turnId, polling.signal, mutationTarget)
      .finally(() => { executionSignal?.removeEventListener('abort', interrupt) })
    return {
      ...accepted.contextReceipt === undefined ? {} : { contextReceipt: accepted.contextReceipt },
      receipt: {
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
        stateRevision: accepted.stateRevision,
      },
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.client.operatorEvents(accepted.sessionId, afterSequence, limit, signal)
        return residentProgressPage(page)
      },
      result,
      // Detach only: the remote daemon retains Receipt, Session, and native execution.
      dispose: () => {
        polling.abort(new Error('remote physical operator observer detached'))
        return Promise.resolve()
      },
    }
  }

  private async settle(
    turnId: string,
    signal: AbortSignal,
    mutationTarget?: MutationTarget,
  ): Promise<PhysicalOperatorResult> {
    while (true) {
      let turn: RemoteResidentTurnSnapshot
      try {
        turn = await this.client.operatorInspect(turnId, signal)
        this.unavailableReason = undefined
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof RemoteSyncTransportError) {
          this.unavailableReason = `${this.server.label} temporarily unreachable: ${error.message}`
          await abortableDelay(this.server.pollIntervalMs ?? 250, signal)
          continue
        }
        this.unavailableReason = `${this.server.label} turn inspection failed: ${renderError(error)}`
        throw new PhysicalOperatorError(
          `accepted remote turn became indeterminate on ${this.server.label}: ${renderError(error)}`,
          'COMMAND_INDETERMINATE',
          { cause: error },
        )
      }
      if (turn.state === 'settled') {
        if (turn.result === undefined) {
          throw new PhysicalOperatorError('remote settled turn omitted its terminal result', 'INVALID_RESULT')
        }
        const materialized = await this.materializeResult(turn, signal)
        const result = {
          ...materialized,
          ...turn.result.workspaceMutation === undefined ? {} : { workspaceMutation: turn.result.workspaceMutation },
        }
        if (mutationTarget !== undefined) {
          const mutation = result.workspaceMutation
          if (mutation === undefined || mutation.baseSha !== mutationTarget.baseSha
            || ('kind' in mutationTarget.identity ? mutation.projectId !== mutationTarget.identity.projectId : mutation.repository !== mutationTarget.identity.repository)) {
            throw new PhysicalOperatorError('remote execution omitted or mismatched its base-bound workspace patch', 'COMMAND_INDETERMINATE')
          }
          const appliedPath = `${this.mutationTargetPath(turn.commandId)}.applied`
          let applied = false
          try { applied = await readFile(appliedPath, 'utf8') === createHash('sha256').update(mutation.patch).digest('hex') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (!applied) {
            await applyMutation(mutationTarget.path, mutationTarget.baseSha, mutation.patch)
            await writeFile(appliedPath, createHash('sha256').update(mutation.patch).digest('hex'), { flag: 'wx', mode: 0o600 })
          }
        }
        const localRef = this.resultStore.putArtifact({
          version: 1,
          kind: 'remote-physical-operator-result',
          serverId: this.server.id,
          turnId: turn.turnId,
          remoteResultRef: turn.result.resultRef,
          result,
        })
        this.resultStore.recordArtifact('compilation_artifacts', { ref: String(localRef) })
        this.resultStore.readArtifact(localRef)
        return {
          output: [...result.output],
          stopReason: result.stopReason,
          ...result.usage === undefined ? {} : { usage: result.usage },
          continuity: { sessionId: turn.sessionId, stateRevision: turn.stateRevision },
        }
      }
      if (turn.state === 'indeterminate') {
        throw new PhysicalOperatorError(
          turn.error?.message ?? 'remote turn outcome is indeterminate',
          'COMMAND_INDETERMINATE',
        )
      }
      await abortableDelay(this.server.pollIntervalMs ?? 250, signal)
    }
  }

  private async materializeResult(
    turn: RemoteResidentTurnSnapshot,
    signal: AbortSignal,
  ): Promise<NonNullable<RemoteResidentTurnSnapshot['result']>> {
    const bounded = turn.result
    if (bounded === undefined) throw new PhysicalOperatorError('remote settled turn omitted its terminal result', 'INVALID_RESULT')
    const ref = bounded.resultRef
    if (ref === undefined) return bounded
    let artifact
    try {
      artifact = await this.client.operatorArtifact(
        ref,
        AbortSignal.any([signal, AbortSignal.timeout(REMOTE_ARTIFACT_TRANSFER_TIMEOUT_MS)]),
      )
    } catch (cause) {
      throw new PhysicalOperatorError(
        `remote result artifact ${ref} could not be transferred: ${renderError(cause)}`,
        'COMMAND_INDETERMINATE',
        { cause },
      )
    }
    if (artifact.ref !== ref) {
      throw new PhysicalOperatorError(`remote result artifact reference mismatch: ${artifact.ref} != ${ref}`, 'INVALID_RESULT')
    }
    const digest = createHash('sha256').update(artifact.json).digest('hex')
    if (`sha256:${digest}` !== ref) {
      throw new PhysicalOperatorError(`remote result artifact digest mismatch: ${ref}`, 'INVALID_RESULT')
    }
    try {
      return parseRemoteResidentResult(JSON.parse(artifact.json) as unknown)
    } catch (cause) {
      throw new PhysicalOperatorError(
        `remote result artifact ${ref} is not a valid Resident result: ${renderError(cause)}`,
        'INVALID_RESULT',
        { cause },
      )
    }
  }
}

function parseMutationTarget(value: unknown): MutationTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid persisted mutation target')
  const record = value as Record<string, unknown>
  const identity = record.identity
  if (typeof record.path !== 'string' || !isAbsolute(record.path)
    || typeof record.baseSha !== 'string' || !/^[a-f0-9]{40}$/u.test(record.baseSha)
    || identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('invalid persisted mutation target')
  const binding = identity as Record<string, unknown>
  if (binding.version !== 1 || (binding.subdir !== undefined && typeof binding.subdir !== 'string')) {
    throw new Error('invalid persisted mutation workspace identity')
  }
  if ('kind' in binding) {
    if (binding.kind !== 'gouzi-project' || typeof binding.projectId !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.projectId)) {
      throw new Error('invalid persisted mutation project identity')
    }
  } else if (typeof binding.repository !== 'string' || binding.repository.length === 0 || binding.commit !== record.baseSha) {
    throw new Error('invalid persisted mutation Git identity')
  }
  return value as MutationTarget
}

async function verifyMutationTarget(cwd: string, baseSha: string): Promise<void> {
  const options = { cwd, encoding: 'utf8' as const, timeout: WORKSPACE_IDENTITY_TIMEOUT_MS }
  const head = await execGit('git', ['rev-parse', 'HEAD'], options)
  const status = await execGit('git', ['status', '--porcelain=v1', '-uall'], options)
  if (head.stdout.trim() !== baseSha || status.stdout.length > 0) throw new PhysicalOperatorError('workspace mutation target must remain clean at the exact execution base', 'WORKSPACE_INVALID')
}

async function applyMutation(cwd: string, baseSha: string, patch: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-return-patch-'))
  const path = join(directory, 'mutation.patch')
  try {
    await verifyMutationTarget(cwd, baseSha)
    if (patch.length === 0) return
    await writeFile(path, patch, { mode: 0o600 })
    const options = { cwd, timeout: WORKSPACE_IDENTITY_TIMEOUT_MS }
    await execGit('git', ['apply', '--check', '--', path], options)
    await execGit('git', ['apply', '--', path], options)
  } catch (cause) {
    throw new PhysicalOperatorError('remote patch could not be integrated into the execution workspace', 'COMMAND_INDETERMINATE', { cause })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Qualify one Server and construct its independently registered remote Providers.
 * @param server - remote DSH Server member to qualify.
 * @param resultStore - local content-addressed artifact owner used for result import.
 * @param request - HTTP implementation used for authenticated control calls.
 * @returns independently registered Physical Operator projections.
 */
export async function createRemotePhysicalOperators(
  server: RemotePhysicalOperatorServer,
  resultStore: RemoteResultStore,
  request: typeof fetch = globalThis.fetch,
): Promise<RemotePhysicalOperator[]> {
  const client = new RemoteSyncHttpClient(server.endpoint, server.accessToken, request)
  return (await client.operatorProviders()).map(provider => new RemotePhysicalOperator(server, provider, resultStore, request))
}
