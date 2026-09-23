/** Owner-local Web coordination preference and MCP endpoint identity. */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const settingsSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['direct', 'coordinator']),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict()

/** Whether selected ChatGPT Web conversations receive DSH tools. */
export type WebCoordinationMode = 'direct' | 'coordinator'

/** Persist only this installation's mode and random MCP path, outside source and Session logs. */
export class WebCoordinatorSettings {
  private value: z.infer<typeof settingsSchema>
  private readonly path: string

  constructor(private readonly root: string) {
    this.path = join(root, 'coordination.json')
    this.value = existsSync(this.path)
      ? settingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, mode: 'direct', token: randomBytes(32).toString('base64url') }
  }

  /** Current explicitly selected mode. */
  get mode(): WebCoordinationMode { return this.value.mode }

  /** Secret MCP route, revealed only through an authenticated local setup view. */
  get mcpPath(): string { return `/mcp/dsh/${this.value.token}` }

  /** Persist the endpoint identity before it is shown to a connector setup client. */
  save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `coordination-${randomBytes(12).toString('hex')}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(this.value)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  /**
   * Persist a local user's explicit choice; failed writes preserve the in-memory mode.
   * @param mode - standalone text or MCP-enabled coordinator.
   */
  select(mode: WebCoordinationMode): void {
    const previous = this.value
    this.value = { ...previous, mode }
    try { this.save() } catch (error) { this.value = previous; throw error }
  }
}
