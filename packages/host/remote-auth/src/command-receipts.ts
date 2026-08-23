/** Durable, payload-free receipts for authenticated remote commands. */

import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Bounded transport result cached for an idempotent remote command. */
export interface RemoteCommandResponse {
  readonly status: number
  readonly contentType?: string
  readonly body: string
}

/** Admission result for a caller-stable remote command identity. */
export type RemoteCommandBeginResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'settled'; readonly response: RemoteCommandResponse }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'running' }

interface RemoteCommandReceipt {
  readonly deviceId: string
  readonly commandId: string
  readonly requestHash: string
  state: 'accepted' | 'settled' | 'indeterminate'
  readonly acceptedAt: string
  settledAt?: string
  response?: RemoteCommandResponse
}

interface RemoteCommandDocument {
  readonly version: 1
  readonly receipts: RemoteCommandReceipt[]
}

/**
 * Small Server-authority receipt journal. Request bodies are represented only
 * by a SHA-256 supplied by the authenticated command boundary; responses are
 * bounded RPC envelopes rather than model output.
 */
export class RemoteCommandReceiptStore {
  private readonly receipts = new Map<string, RemoteCommandReceipt>()
  private operations: Promise<void> = Promise.resolve()

  constructor(
    private readonly filename: string,
    private readonly maxReceipts = 2048,
  ) {}

  /**
   * Load durable receipts and fence commands interrupted after acceptance.
   * @returns a promise settled after recovery and any repair write.
   */
  async init(): Promise<void> {
    let text: string
    try {
      const file = await stat(this.filename)
      if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) {
        throw new Error(`remote-auth: ${this.filename} must be owner-only (chmod 600)`)
      }
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!isRemoteCommandDocument(parsed)) {
      throw new Error(`remote-auth: invalid command receipt journal ${this.filename}`)
    }
    let recovered = false
    for (const receipt of parsed.receipts) {
      if (receipt.state === 'accepted') {
        receipt.state = 'indeterminate'
        recovered = true
      }
      this.receipts.set(receiptKey(receipt.deviceId, receipt.commandId), receipt)
    }
    if (recovered) await this.persist()
  }

  /**
   * Accept or reconcile one authenticated remote command.
   * @param deviceId - authenticated device namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest used for conflict detection.
   * @returns the durable admission or replay result.
   */
  begin(deviceId: string, commandId: string, requestHash: string): Promise<RemoteCommandBeginResult> {
    return this.exclusive(async () => {
      const key = receiptKey(deviceId, commandId)
      const existing = this.receipts.get(key)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) return { kind: 'conflict' }
        if (existing.state === 'settled' && existing.response !== undefined) {
          return { kind: 'settled', response: existing.response }
        }
        return { kind: existing.state === 'accepted' ? 'running' : 'indeterminate' }
      }
      this.receipts.set(key, {
        deviceId,
        commandId,
        requestHash,
        state: 'accepted',
        acceptedAt: new Date().toISOString(),
      })
      this.prune()
      await this.persist()
      return { kind: 'accepted' }
    })
  }

  /**
   * Persist the bounded response for an accepted command.
   * @param deviceId - authenticated device namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest accepted by {@link begin}.
   * @param response - bounded response cached for identical retries.
   * @returns a promise settled after the receipt is durable.
   */
  settle(
    deviceId: string,
    commandId: string,
    requestHash: string,
    response: RemoteCommandResponse,
  ): Promise<void> {
    return this.exclusive(async () => {
      const receipt = this.requireReceipt(deviceId, commandId, requestHash)
      if (receipt.state !== 'accepted') {
        throw new Error(`remote-auth: command ${JSON.stringify(commandId)} cannot settle from ${receipt.state}`)
      }
      receipt.state = 'settled'
      receipt.settledAt = new Date().toISOString()
      receipt.response = response
      await this.persist()
    })
  }

  /**
   * Fence an accepted command whose outcome cannot be proven.
   * @param deviceId - authenticated device namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest accepted by {@link begin}.
   * @returns a promise settled after the receipt is durable.
   */
  markIndeterminate(deviceId: string, commandId: string, requestHash: string): Promise<void> {
    return this.exclusive(async () => {
      const receipt = this.requireReceipt(deviceId, commandId, requestHash)
      if (receipt.state !== 'accepted') return
      receipt.state = 'indeterminate'
      await this.persist()
    })
  }

  private requireReceipt(deviceId: string, commandId: string, requestHash: string): RemoteCommandReceipt {
    const receipt = this.receipts.get(receiptKey(deviceId, commandId))
    if (receipt === undefined || receipt.requestHash !== requestHash) {
      throw new Error(`remote-auth: command receipt ${JSON.stringify(commandId)} is unavailable`)
    }
    return receipt
  }

  private prune(): void {
    if (this.receipts.size <= this.maxReceipts) return
    const settled = [...this.receipts.entries()]
      .filter(([, receipt]) => receipt.state === 'settled')
      .sort((left, right) => left[1].acceptedAt.localeCompare(right[1].acceptedAt))
    for (const [key] of settled) {
      if (this.receipts.size <= this.maxReceipts) break
      this.receipts.delete(key)
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operations.then(operation, operation)
    this.operations = current.then(() => undefined, () => undefined)
    return current
  }

  private persist(): Promise<void> {
    const document: RemoteCommandDocument = { version: 1, receipts: [...this.receipts.values()] }
    return writeFileAtomic(this.filename, `${JSON.stringify(document, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

function receiptKey(deviceId: string, commandId: string): string {
  return `${deviceId}\0${commandId}`
}

function isRemoteCommandDocument(value: unknown): value is RemoteCommandDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const document = value as { version?: unknown; receipts?: unknown }
  return document.version === 1 && Array.isArray(document.receipts)
    && document.receipts.every(isRemoteCommandReceipt)
}

function isRemoteCommandReceipt(value: unknown): value is RemoteCommandReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  const response = receipt.response
  return typeof receipt.deviceId === 'string' && receipt.deviceId.length > 0
    && typeof receipt.commandId === 'string' && receipt.commandId.length > 0
    && typeof receipt.requestHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.requestHash)
    && (receipt.state === 'accepted' || receipt.state === 'settled' || receipt.state === 'indeterminate')
    && typeof receipt.acceptedAt === 'string' && !Number.isNaN(Date.parse(receipt.acceptedAt))
    && (receipt.settledAt === undefined
      || (typeof receipt.settledAt === 'string' && !Number.isNaN(Date.parse(receipt.settledAt))))
    && (response === undefined || isRemoteCommandResponse(response))
    && (receipt.state !== 'settled' || response !== undefined)
}

function isRemoteCommandResponse(value: unknown): value is RemoteCommandResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Number.isInteger(response.status) && Number(response.status) >= 100 && Number(response.status) <= 599
    && typeof response.body === 'string'
    && (response.contentType === undefined || typeof response.contentType === 'string')
}
