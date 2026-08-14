/** Host half of the configurable multi-instance Web page sidebar plugin. */
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  REMOTE_MODULES_SETTINGS_NAMESPACE, WEBPAGE_INSTANCES_PATH,
  type RemoteModulesConfig, type WebpageInstanceConfig,
  type WebpageInstanceView, type WebpageInstancesResponse,
} from './contract.ts'
import { parseWebpageTarget, startWebpageRelay } from './relay.ts'

/** Stable Cordis plugin name. */
export const name = 'client-ui-remote-modules'

/** Required Host services: the Web server and durable user-settings provider. */
export const inject = ['webServer', 'settings']

/** Cordis entry configuration accepted by the plugin. */
export type Config = RemoteModulesConfig

const WebpageInstanceSchema: z<WebpageInstanceConfig> = z.object({
  id: z.string().required(),
  label: z.string().required(),
  url: z.string().required(),
  relayPort: z.natural().max(65535).default(0),
  order: z.number().default(100),
})

/** Validated Host configuration. */
export const Config: z<Config> = z.object({
  instances: z.array(WebpageInstanceSchema).min(1),
})

/**
 * Validate and deterministically order configured page instances.
 * @param instances - Operator-owned instance definitions from Cordis config.
 * @returns Normalized instances sorted by order and then label.
 */
export function normalizeWebpageInstances(instances: WebpageInstanceConfig[]): WebpageInstanceConfig[] {
  const ids = new Set<string>()
  const ports = new Set<number>()
  return instances.map((candidate, index) => {
    const id = candidate.id.trim()
    const label = candidate.label.trim()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`ui-remote-modules: instances[${String(index)}].id must be kebab-case`)
    }
    if (ids.has(id)) throw new Error(`ui-remote-modules: duplicate instance id ${id}`)
    if (label === '') throw new Error(`ui-remote-modules: instances[${String(index)}].label must not be empty`)
    if (!Number.isSafeInteger(candidate.order)) {
      throw new Error(`ui-remote-modules: instances[${String(index)}].order must be an integer`)
    }
    if (candidate.relayPort !== 0 && ports.has(candidate.relayPort)) {
      throw new Error(`ui-remote-modules: duplicate relayPort ${String(candidate.relayPort)}`)
    }
    parseWebpageTarget(`instances[${String(index)}].url`, candidate.url)
    ids.add(id)
    if (candidate.relayPort !== 0) ports.add(candidate.relayPort)
    return { ...candidate, id, label }
  }).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
}

function sendJson(res: ServerResponse, body: WebpageInstancesResponse, head: boolean): void {
  const serialized = JSON.stringify(body)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(serialized),
  })
  res.end(head ? undefined : serialized)
}

/** Start one loopback relay per configured instance and publish their browser roster. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const scope = ctx.settings.register(
    settingsNamespace(REMOTE_MODULES_SETTINGS_NAMESPACE),
    Config,
    {
      base: config,
      applies: 'restart',
      validate: (value) => { normalizeWebpageInstances(value.instances) },
    },
  )
  const configured = normalizeWebpageInstances(scope.get().instances)
  const roster: WebpageInstanceView[] = []
  for (const instance of configured) {
    const relay = await startWebpageRelay({
      id: instance.id,
      targetUrl: instance.url,
      port: instance.relayPort,
    })
    ctx.effect(() => async () => { await relay.close() }, `client-ui-remote-modules: ${instance.id} relay`)
    roster.push({
      id: instance.id,
      label: instance.label,
      targetUrl: relay.target.href,
      embedUrl: relay.embedUrl,
      order: instance.order,
    })
  }
  const response: WebpageInstancesResponse = { instances: roster }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WEBPAGE_INSTANCES_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      sendJson(res, response, req.method === 'HEAD')
    },
  }), 'client-ui-remote-modules: instance roster')
}

export { WEBPAGE_INSTANCES_PATH, parseWebpageInstances } from './contract.ts'
export type { RemoteModulesConfig, WebpageInstanceConfig } from './contract.ts'
export { parseWebpageTarget, startWebpageRelay } from './relay.ts'
