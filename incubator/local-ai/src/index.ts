import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_GATEWAY_PORT, DEFAULT_TAILSCALE_PROXY } from './endpoint.js'
import { startTailnetGateway, type TailnetGateway } from './gateway.js'

/**
 * Host half of the local AI bundle.
 *
 * Model calls go through the official `llm-pi-ai` adapter; the Settings page
 * writes its route. This half only owns the optional Tailscale gateway, which
 * runs while `tailscale.enabled` is set. The fields are volatile so the page
 * can switch them through the settings service without remounting the plugin.
 */
export const name = 'solar-local-ai'

export interface TailscaleConfig {
  enabled: boolean
  port: number
  proxy: string
}

export const Config = z.object({
  tailscale: z.object({
    enabled: z.boolean().default(false)
      .description('Run the loopback gateway that reaches tailnet endpoints through a userspace tailscaled.'),
    port: z.natural().min(1024).max(65535).default(DEFAULT_GATEWAY_PORT)
      .description('Loopback port of the gateway. Changing it requires saving the Local AI page again.'),
    proxy: z.string().pattern(/^socks5h?:\/\/[^/\s]+:\d{1,5}\/?$/).default(DEFAULT_TAILSCALE_PROXY)
      .description('SOCKS5 address of the userspace tailscaled (its --socks5-server flag).'),
  }).default({ enabled: false, port: DEFAULT_GATEWAY_PORT, proxy: DEFAULT_TAILSCALE_PROXY }).volatile(),
})

export type Config = Schemastery.TypeT<typeof Config>

function sameGateway(left: TailscaleConfig | undefined, right: TailscaleConfig): boolean {
  return left !== undefined && left.enabled === right.enabled && left.port === right.port && left.proxy === right.proxy
}

export function apply(ctx: Context, config: Config): void {
  let applied: TailscaleConfig | undefined
  let running: Promise<TailnetGateway | undefined> = Promise.resolve(undefined)

  const sync = (): void => {
    const next = { ...config.tailscale.get() }
    if (sameGateway(applied, next)) return
    applied = next
    running = running
      .then(gateway => gateway?.close())
      .then(() => next.enabled ? startTailnetGateway(next) : undefined)
      .then(gateway => {
        if (gateway !== undefined) ctx.logger.info('local-ai: Tailscale gateway listening on 127.0.0.1:%d via %s', gateway.port, next.proxy)
        return gateway
      }, (error: unknown) => {
        ctx.logger.error(error)
        return undefined
      })
  }

  ctx.effect(() => {
    sync()
    return () => {
      applied = undefined
      running = running.then(gateway => gateway?.close()).then(() => undefined)
    }
  }, 'local-ai: tailscale gateway')
  ctx.on('loader/volatile-update', sync)
}
