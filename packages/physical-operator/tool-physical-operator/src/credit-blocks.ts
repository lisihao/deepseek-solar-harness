/**
 * Models that the account cannot use without extra paid usage credits. The native catalog lists them as
 * available, so a run is the only evidence; the record survives restarts and expires so a later purchase of
 * credits takes effect.
 * @module @deepseek-ai/dsh-tool-physical-operator/credit-blocks
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const FILE_NAME = 'credit-blocked.json'

/** One blocked `operator:model` key and when its run reported the credits requirement. */
interface BlockedEntry {
  readonly key: string
  readonly blockedAt: number
}

/** Durable, expiring set of `operator:model` keys whose runs reported a usage-credits requirement. */
export class CreditBlockStore {
  private readonly memory = new Map<string, number>()
  private loaded = false

  /**
   * @param root - directory that holds the record; without one the set lives for this process only.
   * @param ttlMs - how long a block lasts after the run that reported it.
   * @param warn - receives a message when the stored record cannot be read or written.
   */
  constructor(
    private readonly root: string | undefined,
    private readonly ttlMs: number,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * The keys whose block has not expired.
   * @param now - current time in epoch milliseconds.
   * @returns `operator:model` keys.
   */
  active(now = Date.now()): ReadonlySet<string> {
    this.load()
    return new Set([...this.memory].filter(([, blockedAt]) => now - blockedAt < this.ttlMs).map(([key]) => key))
  }

  /**
   * Record that a run on this model reported the credits requirement.
   * @param key - `operator:model`.
   * @param now - current time in epoch milliseconds.
   */
  block(key: string, now = Date.now()): void {
    this.load()
    this.memory.set(key, now)
    this.persist()
  }

  /**
   * Forget a block after a run on the model completed.
   * @param key - `operator:model`.
   */
  clear(key: string): void {
    this.load()
    if (this.memory.delete(key)) this.persist()
  }

  private path(): string | undefined {
    return this.root === undefined || this.root === '' ? undefined : join(this.root, FILE_NAME)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const path = this.path()
    if (path === undefined) return
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      // A missing record is the normal first run; any other failure only loses the persisted blocks.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`credit-blocked record unreadable: ${String(error)}`)
      return
    }
    try {
      const parsed = JSON.parse(text) as { readonly blocked?: readonly BlockedEntry[] }
      for (const entry of parsed.blocked ?? []) {
        if (typeof entry.key === 'string' && typeof entry.blockedAt === 'number') this.memory.set(entry.key, entry.blockedAt)
      }
    } catch (error) {
      this.warn(`credit-blocked record is not valid JSON and is ignored: ${String(error)}`)
    }
  }

  private persist(): void {
    const path = this.path()
    if (path === undefined) return
    const blocked: BlockedEntry[] = [...this.memory].map(([key, blockedAt]) => ({ key, blockedAt }))
    const temporary = `${path}.${String(process.pid)}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, `${JSON.stringify({ version: 1, blocked })}\n`, { mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      this.warn(`credit-blocked record not saved: ${String(error)}`)
    }
  }
}

/**
 * The `operator:model` keys that earlier dispatches of this session ended with the credits-required code.
 * @param events - the session's ordered durable log.
 * @param code - the terminal code that marks the credits requirement.
 * @returns the blocked keys.
 */
export function sessionCreditBlocked(events: readonly SessionEvent[], code: string): ReadonlySet<string> {
  const blocked = new Set<string>()
  for (const event of events) {
    if (event.type !== 'physical-operator/dispatch-terminal' || event.data.code !== code) continue
    const dispatch = events.find(candidate => candidate.type === 'physical-operator/dispatch'
      && candidate.data.commandId === event.data.commandId)
    if (dispatch?.type === 'physical-operator/dispatch' && dispatch.data.residentProfile?.model !== undefined) {
      blocked.add(`${dispatch.data.operatorId}:${dispatch.data.residentProfile.model}`)
    }
  }
  return blocked
}
