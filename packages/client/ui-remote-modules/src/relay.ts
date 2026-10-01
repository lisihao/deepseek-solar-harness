/** Fixed-target loopback relay used to embed applications that deny framing. */
import { createServer, request as httpRequest } from 'node:http'
import type {
  ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

/** Validated relay input owned by one configured plugin instance. */
export interface WebpageRelayOptions {
  id: string
  targetUrl: string
  port: number
  /** Decides whether the relay follows a target redirect to another origin; defaults to {@link followsPublicAlias}. */
  followsRedirect?: (from: URL, to: URL) => boolean
}

/** Running loopback relay and its deterministic browser-facing URL. */
export interface WebpageRelay {
  target: URL
  embedUrl: string
  close: () => Promise<void>
}

/** Mutable fixed target: moves only along redirects that the target's own site issues to a public alias. */
interface RelayState {
  target: URL
  followed: number
  followsRedirect: (from: URL, to: URL) => boolean
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Upper bound on origin changes one relay follows, so a redirect loop cannot move the target forever. */
const MAX_FOLLOWED_REDIRECTS = 8

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Validate one operator-owned HTTP(S) page target.
 * @param field - Configuration field name used in actionable errors.
 * @param value - Candidate full page URL.
 * @returns Parsed credential-free HTTP(S) target.
 */
export function parseWebpageTarget(field: string, value: string): URL {
  let target: URL
  try { target = new URL(value) } catch { throw new Error(`ui-remote-modules: ${field} must be an HTTP(S) URL`) }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:')
    || target.username !== '' || target.password !== '') {
    throw new Error(`ui-remote-modules: ${field} must be an HTTP(S) URL without credentials`)
  }
  return target
}

function isPublicDnsName(hostname: string): boolean {
  return hostname.includes('.') && !hostname.includes(':') && !/^[\d.]+$/.test(hostname)
    && !hostname.endsWith('.localhost') && !hostname.endsWith('.local')
}

/**
 * Default rule for a target redirect that leaves the configured origin, such as
 * `http://www.x.com` to `https://twitter.com/` to `https://x.com/`. Both ends must be
 * public DNS names, so a loopback or private-address target never moves and a public
 * site cannot send the relay to an internal address.
 * @param from - Origin the relay currently forwards to.
 * @param to - Absolute redirect destination.
 * @returns Whether the relay should forward to the destination from now on.
 */
export function followsPublicAlias(from: URL, to: URL): boolean {
  return isPublicDnsName(from.hostname) && isPublicDnsName(to.hostname)
    && to.username === '' && to.password === ''
}

function followRedirect(state: RelayState, status: number, location: string | undefined): void {
  if (!REDIRECT_STATUSES.has(status) || location === undefined) return
  let destination: URL
  try { destination = new URL(location) } catch { return }
  if ((destination.protocol !== 'http:' && destination.protocol !== 'https:')
    || destination.origin === state.target.origin
    || state.followed >= MAX_FOLLOWED_REDIRECTS
    || !state.followsRedirect(state.target, destination)) return
  state.followed += 1
  state.target = new URL(destination.origin)
}

function incomingPath(requestUrl: string | undefined, target: URL): string {
  const incoming = new URL(requestUrl ?? '/', 'http://relay.invalid')
  if (incoming.pathname !== '/') return `${incoming.pathname}${incoming.search}`
  return `${target.pathname}${incoming.search || target.search}`
}

function cspWithoutFrameAncestors(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return (Array.isArray(value) ? value.join('; ') : value)
    .split(';')
    .map(part => part.trim())
    .filter(part => part !== '' && !part.toLowerCase().startsWith('frame-ancestors'))
    .join('; ')
}

function responseHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  relayOrigin: string,
  instanceId: string,
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (rawValue === undefined || HOP_HEADERS.has(name) || name === 'x-frame-options') continue
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      const rewritten = cspWithoutFrameAncestors(rawValue)
      if (rewritten !== undefined && rewritten !== '') output[name] = rewritten
      continue
    }
    if (name === 'set-cookie') {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue]
      output[name] = values.map(value => value.replace(/;\s*Domain=[^;]+/gi, ''))
      continue
    }
    if (name === 'location' && typeof rawValue === 'string') {
      output[name] = rawValue.startsWith(target.origin)
        ? `${relayOrigin}${rawValue.slice(target.origin.length)}`
        : rawValue
      continue
    }
    output[name] = rawValue
  }
  output['x-dsh-webpage-instance'] = instanceId
  return output
}

function requestHeaders(headers: IncomingHttpHeaders, target: URL, relayOrigin: string): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (rawValue === undefined || HOP_HEADERS.has(name) || name === 'host') continue
    output[name] = rawValue
  }
  output.host = target.host
  if (output.origin === relayOrigin) output.origin = target.origin
  if (typeof output.referer === 'string' && output.referer.startsWith(relayOrigin)) {
    output.referer = `${target.origin}${output.referer.slice(relayOrigin.length)}`
  }
  return output
}

function requester(target: URL): typeof httpRequest {
  return target.protocol === 'https:' ? httpsRequest : httpRequest
}

function relayOrigin(req: IncomingMessage, port: number): string {
  const authority = req.headers.host?.trim()
  return `http://${authority === undefined || authority === '' ? `127.0.0.1:${String(port)}` : authority}`
}

function upstreamRequest(
  req: IncomingMessage,
  target: URL,
  port: number,
  onResponse: (response: IncomingMessage, origin: string) => void,
): ClientRequest {
  const origin = relayOrigin(req, port)
  const upstream = requester(target)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === '' ? undefined : Number(target.port),
    method: req.method,
    path: incomingPath(req.url, target),
    headers: requestHeaders(req.headers, target, origin),
  }, (response) => { onResponse(response, origin) })
  return upstream
}

function handleHttp(req: IncomingMessage, res: ServerResponse, state: RelayState, port: number, id: string): void {
  const upstream = upstreamRequest(req, state.target, port, (response, origin) => {
    const status = response.statusCode ?? 502
    followRedirect(state, status, response.headers.location)
    const headers = responseHeaders(response.headers, state.target, origin, id)
    // A followed alias can turn a redirect into a link to the same relay URL; a cached permanent one would loop.
    if (REDIRECT_STATUSES.has(status) && headers['cache-control'] === undefined) headers['cache-control'] = 'no-store'
    res.writeHead(status, response.statusMessage, headers)
    response.pipe(res)
  })
  upstream.on('error', (error) => {
    if (res.headersSent) { res.destroy(error); return }
    const body = `Web page target unavailable: ${error.message}`
    res.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  req.pipe(upstream)
}

function rawHeaders(statusCode: number, statusMessage: string | undefined, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${String(statusCode)} ${statusMessage ?? 'Switching Protocols'}`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function handleUpgrade(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  state: RelayState,
  port: number,
): void {
  const { target } = state
  const origin = relayOrigin(req, port)
  const headers = requestHeaders(req.headers, target, origin)
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade ?? 'websocket'
  const upstream = requester(target)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === '' ? undefined : Number(target.port),
    method: req.method,
    path: incomingPath(req.url, target),
    headers,
  })
  upstream.on('upgrade', (response, socket, proxyHead) => {
    client.write(rawHeaders(response.statusCode ?? 101, response.statusMessage, response.headers))
    if (proxyHead.length > 0) client.write(proxyHead)
    socket.pipe(client).pipe(socket)
  })
  upstream.on('response', (response) => {
    client.write(rawHeaders(response.statusCode ?? 502, response.statusMessage, response.headers))
    response.pipe(client)
  })
  upstream.on('error', () => { client.destroy() })
  upstream.end(head)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
    const onListening = (): void => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Start one local-only fixed-target relay. The relay is not an open proxy: all
 * incoming paths stay on the single configured origin, which moves only when that
 * site redirects to another public DNS name (see {@link followsPublicAlias}).
 * @param options - Validated instance id, target URL, and loopback port.
 * @returns The running relay, public embed URL, and async disposer.
 */
export async function startWebpageRelay(options: WebpageRelayOptions): Promise<WebpageRelay> {
  const target = parseWebpageTarget(`${options.id}.url`, options.targetUrl)
  const sockets = new Set<Duplex>()
  const state: RelayState = { target, followed: 0, followsRedirect: options.followsRedirect ?? followsPublicAlias }
  let boundPort = options.port
  const server = createServer((req, res) => { handleHttp(req, res, state, boundPort, options.id) })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head, state, boundPort) })
  boundPort = await listen(server, options.port)
  const base = `http://localhost:${String(boundPort)}`
  const embedUrl = `${base}${target.pathname}${target.search}${target.hash}`
  return {
    target,
    embedUrl,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
      })
    },
  }
}
