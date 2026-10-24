import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { GATEWAY_HOST, isTailnetHost, parseGatewayPath } from './endpoint.js'

/**
 * Loopback HTTP gateway into a tailnet for a userspace `tailscaled`.
 *
 * A userspace node creates no network interface, so ordinary sockets cannot
 * reach 100.x addresses; only its SOCKS5 server can. Model adapters open plain
 * sockets, so this gateway accepts `http://127.0.0.1:<port>/tailnet/<host>:<port>/…`
 * and relays each request through the SOCKS5 proxy, streaming both bodies.
 */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export class TailnetGatewayError extends Error {
  override readonly name = 'TailnetGatewayError'
}

export interface TailnetGatewayOptions {
  readonly port: number
  /** `socks5://host:port`; names are always resolved by the proxy (socks5h). */
  readonly proxy: string
}

export interface TailnetGateway {
  readonly port: number
  close(): Promise<void>
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'host') continue
    result[name] = value
  }
  return result
}

function fail(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy(new TailnetGatewayError(message))
    return
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message, type: 'tailnet_gateway_error' } }))
}

/** Rewrite `socks5://` to `socks5h://` so MagicDNS names resolve inside tailscaled. */
export function proxyAgentURL(proxy: string): string {
  const url = new URL(proxy)
  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') {
    throw new TailnetGatewayError(`Tailscale proxy must be a socks5:// address, got ${url.protocol}//`)
  }
  url.protocol = 'socks5h:'
  return url.href
}

export async function startTailnetGateway(options: TailnetGatewayOptions): Promise<TailnetGateway> {
  const agent = new SocksProxyAgent(proxyAgentURL(options.proxy))

  const relay = (incoming: IncomingMessage, response: ServerResponse): void => {
    const target = parseGatewayPath(incoming.url ?? '')
    if (target === undefined) {
      fail(response, 404, 'Expected a path of the form /tailnet/<host>:<port>/…')
      return
    }
    if (!isTailnetHost(target.host)) {
      fail(response, 403, `${target.host} is not a Tailscale address; the gateway only relays to 100.64.0.0/10, fd7a:115c:a1e0::/48, and *.ts.net`)
      return
    }
    const upstream = request({
      host: target.host.replace(/^\[|\]$/g, ''),
      port: target.port,
      method: incoming.method,
      path: target.path,
      headers: { ...forwardHeaders(incoming.headers), host: `${target.host}:${String(target.port)}` },
      agent,
    })
    upstream.on('response', answer => {
      response.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers))
      answer.pipe(response)
    })
    upstream.on('error', error => {
      fail(response, 502, `Could not reach ${target.host}:${String(target.port)} through the Tailscale proxy ${options.proxy}: ${error.message}`)
    })
    response.on('close', () => { if (!response.writableFinished) upstream.destroy() })
    incoming.pipe(upstream)
  }

  const server = createServer(relay)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(new TailnetGatewayError(error.code === 'EADDRINUSE'
        ? `Tailscale gateway port ${String(options.port)} on ${GATEWAY_HOST} is already in use; choose another port`
        : `Tailscale gateway could not listen on ${GATEWAY_HOST}:${String(options.port)}: ${error.message}`))
    }
    server.once('error', onError)
    server.listen(options.port, GATEWAY_HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
      agent.destroy()
    }),
  }
}
