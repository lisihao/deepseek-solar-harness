/** Versioned remote execution member catalog owned by the orchestration composition root. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemotePhysicalOperatorServer } from '@deepseek-ai/dsh-client-connection'

export const REMOTE_OPERATOR_CATALOG_VERSION = 1

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-blank trimmed string`)
  }
  return value
}

/** Read the optional remote capacity catalog; absence means local-only scheduling. */
export function readRemoteOperatorCatalog(root: string): RemotePhysicalOperatorServer[] {
  const path = join(root, 'remote-operators.json')
  if (!existsSync(path)) return []
  const payload: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const catalog = record(payload, 'remote operator catalog')
  if (catalog.version !== REMOTE_OPERATOR_CATALOG_VERSION) {
    throw new Error(`remote operator catalog version must be ${String(REMOTE_OPERATOR_CATALOG_VERSION)}`)
  }
  if (!Array.isArray(catalog.servers)) throw new Error('remote operator catalog servers must be an array')
  const ids = new Set<string>()
  return catalog.servers.map((value, index) => {
    const server = record(value, `remote operator server ${index}`)
    const id = string(server.id, `remote operator server ${index}.id`)
    if (ids.has(id)) throw new Error(`remote operator catalog contains duplicate server id "${id}"`)
    ids.add(id)
    const endpoint = string(server.endpoint, `remote operator server ${index}.endpoint`)
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`remote operator server ${index}.endpoint must use http or https`)
    }
    if (server.accessToken !== undefined) {
      throw new Error('remote operator catalog cannot persist accessToken; use a trusted local tunnel or credential broker')
    }
    return {
      id,
      label: string(server.label, `remote operator server ${index}.label`),
      endpoint: url.href,
      ...server.pollIntervalMs === undefined ? {} : {
        pollIntervalMs: (() => {
          if (!Number.isSafeInteger(server.pollIntervalMs) || Number(server.pollIntervalMs) < 10) {
            throw new Error(`remote operator server ${index}.pollIntervalMs must be at least 10`)
          }
          return Number(server.pollIntervalMs)
        })(),
      },
    }
  })
}
