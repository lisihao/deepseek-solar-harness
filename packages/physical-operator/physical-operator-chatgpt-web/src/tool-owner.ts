/** Exact webpage request evidence binds MCP calls to one active DSH execution. */

import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { requestLocalJsonRpc } from '@deepseek-ai/dsh-sdk-protocol'
import type { WebMcpCallId } from './types.ts'

interface Owner {
  readonly commandId: string
  readonly bridge: PhysicalOperatorModelToolBridgeV1
  readonly signal: AbortSignal
  conversationId?: string
  activeCalls: number
}

/** MCP execution authority proven by the current native ChatGPT turn. */
export interface WebToolOwner {
  readonly tools: PhysicalOperatorModelToolBridgeV1['tools']
  /** Release this inbound request only after its response and actual work settle. */
  release(): void
  /**
   * Execute an advertised tool with distinct owner proof and durable receipt identities.
   * @param proofId - normalized request identity accepted as owner proof.
   * @param name - advertised owner-local tool name.
   * @param args - validated tool arguments.
   * @param signal - MCP-call cancellation signal.
   * @param callId - opaque receipt identity for this exact MCP wire call.
   * @returns the owner-local tool result.
   */
  execute(proofId: string, name: string, args: Record<string, unknown>, signal: AbortSignal, callId: WebMcpCallId): Promise<unknown>
}

/** Active browser run's observation and teardown operations. */
export interface WebToolOwnerBinding {
  /** Register only IDs observed in this command's exact native user turn. */
  observe(conversationId: string, requestIds: readonly string[]): void
  /** Whether a local tool result is still owed to the website. */
  hasPendingTools(): boolean
  /** Revoke this run's authority without transferring it to another run. */
  release(): void
}

/** Joins native request IDs to owner-local tools without model-supplied credentials. */
export class WebToolOwners {
  private readonly owners = new Map<string, Owner>()
  private readonly proofs = new Map<string, Owner | null>()
  private readonly pendingRequests = new Map<string, number>()
  private readonly changed = new Set<() => void>()

  constructor(private readonly identityTimeoutMs: number) {
    if (!Number.isSafeInteger(identityTimeoutMs) || identityTimeoutMs <= 0) {
      throw new Error('Web tool identity timeout must be a positive integer')
    }
  }

  /**
   * Attach one execution's sealed tool surface until its browser run settles.
   * @param commandId - DSH physical execution identity.
   * @param bridge - real owner-local tool bridge descriptor.
   * @param signal - cancellation authority of the owning run.
   * @returns operations for exact page observations and revocation.
   */
  bind(commandId: string, bridge: PhysicalOperatorModelToolBridgeV1, signal: AbortSignal): WebToolOwnerBinding {
    if (signal.aborted) throw new Error('Web tool owner was cancelled')
    if (this.owners.has(commandId)) throw new Error('Web tool owner is already attached')
    const owner: Owner = { commandId, bridge, signal, activeCalls: 0 }
    this.owners.set(commandId, owner)
    return {
      observe: (conversationId, requestIds) => {
        if (this.owners.get(commandId) !== owner || signal.aborted) return
        if (conversationId.length === 0 || owner.conversationId !== undefined && owner.conversationId !== conversationId) {
          throw new Error('Web tool conversation identity changed during an execution')
        }
        owner.conversationId = conversationId
        for (const requestId of requestIds) {
          if (requestId.length === 0 || requestId.length > 256 || requestId.trim() !== requestId) {
            throw new Error('Web tool request evidence contains an invalid identity')
          }
          const existing = this.proofs.get(requestId)
          if (existing === undefined) this.proofs.set(requestId, owner)
          else if (existing !== owner) this.proofs.set(requestId, null)
        }
        this.notify()
      },
      hasPendingTools: () => owner.activeCalls > 0 || [...this.pendingRequests.keys()].some((id) => {
        const proof = this.proofs.get(id)
        return proof === undefined || proof === owner
      }),
      release: () => {
        if (this.owners.get(commandId) !== owner) return
        this.owners.delete(commandId)
        // Revoked IDs remain tombstones. A later run cannot adopt an old request.
        for (const [id, proof] of this.proofs) if (proof === owner) this.proofs.set(id, null)
        this.notify()
      },
    }
  }

  /**
   * Await exact page evidence before returning any tool schemas or authority.
   * @param requestId - unique x-request-id from the MCP HTTP request.
   * @param signal - inbound request cancellation channel.
   * @returns this native request's sealed DSH tool surface.
   */
  async resolve(requestId: string, signal: AbortSignal): Promise<WebToolOwner> {
    this.pendingRequests.set(requestId, (this.pendingRequests.get(requestId) ?? 0) + 1)
    let leased = true
    const release = (): void => {
      if (!leased) return
      leased = false
      const remaining = (this.pendingRequests.get(requestId) ?? 1) - 1
      if (remaining === 0) this.pendingRequests.delete(requestId)
      else this.pendingRequests.set(requestId, remaining)
    }
    let owner: Owner
    try { owner = await this.prove(requestId, signal) } catch (error) { release(); throw error }
    return {
      tools: owner.bridge.tools,
      release,
      execute: async (proofId, name, args, callSignal, callId) => {
        if (!leased || proofId !== requestId || !this.current(requestId, owner) || callSignal.aborted) {
          throw new Error('Web tool request no longer has a proven owner')
        }
        if (!owner.bridge.tools.some(tool => tool.name === name)) throw new Error('Web tool is not advertised for this owner')
        owner.activeCalls += 1
        try {
          return await callOwnerTool(owner.bridge, name, args, `${owner.commandId}:chatgpt-web:${callId}`,
            AbortSignal.any([owner.signal, callSignal]))
        } finally {
          owner.activeCalls -= 1
        }
      },
    }
  }

  private current(requestId: string, owner: Owner): boolean {
    return this.proofs.get(requestId) === owner && this.owners.get(owner.commandId) === owner && !owner.signal.aborted
  }

  private prove(requestId: string, signal: AbortSignal): Promise<Owner> {
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        this.changed.delete(check)
        signal.removeEventListener('abort', abort)
        clearTimeout(timer)
      }
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(message))
      }
      const abort = (): void => { fail('Web tool identity request was cancelled') }
      const check = (): void => {
        const proof = this.proofs.get(requestId)
        if (proof === null) { fail('Web tool request identity is revoked or ambiguous'); return }
        if (proof === undefined) return
        if (!this.current(requestId, proof)) { fail('Web tool owner is no longer active'); return }
        settled = true
        cleanup()
        resolve(proof)
      }
      const timer = setTimeout(() => { fail('Web tool caller identity was not observed in its ChatGPT conversation') }, this.identityTimeoutMs)
      this.changed.add(check)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else check()
    })
  }

  private notify(): void {
    for (const listener of this.changed) listener()
  }
}

async function callOwnerTool(
  bridge: PhysicalOperatorModelToolBridgeV1,
  name: string,
  args: Record<string, unknown>,
  commandId: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  return await requestLocalJsonRpc(bridge.socketPath, 'tool.call', {
    session_id: bridge.sessionId,
    command_id: commandId,
    tool: name,
    arguments: args,
  }, signal, () => new Error('Web tool execution was cancelled'))
}
