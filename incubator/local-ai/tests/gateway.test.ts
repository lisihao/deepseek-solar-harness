import { createServer as createHttpServer, request, type Server as HttpServer } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { startTailnetGateway, proxyAgentURL, type TailnetGateway } from '../src/gateway.js'

interface SocksStub {
  readonly server: TcpServer
  readonly port: number
  /** Every CONNECT target the stub was asked for, as host:port. */
  readonly requested: string[]
}

/**
 * Minimal SOCKS5 server: no authentication, CONNECT only. It records the
 * requested tailnet target and connects to the local upstream instead, the
 * way tailscaled would connect into the tailnet.
 */
async function startSocksStub(upstreamPort: number): Promise<SocksStub> {
  const requested: string[] = []
  const server = createTcpServer((client: Socket) => {
    let buffer = Buffer.alloc(0)
    let stage: 'greeting' | 'request' | 'piping' = 'greeting'
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return
        buffer = buffer.subarray(2 + buffer[1]!)
        client.write(Buffer.from([5, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buffer.length < 5) return
        const atyp = buffer[3]!
        const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4]!
        const total = 4 + addressLength + 2
        if (buffer.length < total) return
        const address = buffer.subarray(4, 4 + addressLength)
        const host = atyp === 1 ? [...address].join('.') : atyp === 3 ? address.subarray(1).toString() : address.toString('hex')
        const port = buffer.readUInt16BE(4 + addressLength)
        requested.push(`${host}:${String(port)}`)
        const rest = buffer.subarray(total)
        stage = 'piping'
        client.off('data', onData)
        const upstream = connect(upstreamPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length > 0) upstream.write(rest)
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      }
    }
    client.on('data', onData)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, requested }
}

/** OpenAI-shaped upstream that lists one model and streams a two-part reply. */
async function startUpstream(): Promise<{ server: HttpServer, port: number, seen: { path?: string, host?: string, auth?: string } }> {
  const seen: { path?: string, host?: string, auth?: string } = {}
  const server = createHttpServer((incoming, response) => {
    seen.path = incoming.url
    seen.host = incoming.headers.host
    seen.auth = incoming.headers.authorization
    if (incoming.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-local', object: 'model' }] }))
      return
    }
    let body = ''
    incoming.on('data', chunk => { body += String(chunk) })
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ echo: JSON.parse(body).model, part: 1 })}\n\n`)
      setTimeout(() => {
        response.write('data: {"part":2}\n\n')
        response.end('data: [DONE]\n\n')
      }, 30)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, seen }
}

function call(port: number, path: string, init: { method?: string, body?: string, headers?: Record<string, string> } = {}): Promise<{ status: number, body: string, chunks: number }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, response => {
      let body = ''
      let chunks = 0
      response.on('data', chunk => { body += String(chunk); chunks++ })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, chunks }))
    })
    outgoing.on('error', reject)
    outgoing.end(init.body)
  })
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(): Promise<{ gateway: TailnetGateway, socks: SocksStub, upstream: Awaited<ReturnType<typeof startUpstream>> }> {
  const upstream = await startUpstream()
  cleanups.push(() => new Promise<void>(resolve => { upstream.server.closeAllConnections(); upstream.server.close(() => resolve()) }))
  const socks = await startSocksStub(upstream.port)
  cleanups.push(() => new Promise<void>(resolve => socks.server.close(() => resolve())))
  const gateway = await startTailnetGateway({ port: 0, proxy: `socks5://127.0.0.1:${String(socks.port)}` })
  cleanups.push(() => gateway.close())
  return { gateway, socks, upstream }
}

describe('tailnet gateway', () => {
  test('relays model discovery through SOCKS5 to the tailnet target', async () => {
    const { gateway, socks, upstream } = await fixture()
    const answer = await call(gateway.port, '/tailnet/100.114.161.62:8000/v1/models', { headers: { authorization: 'Bearer local-ai-no-key' } })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).data[0].id).toBe('qwen-local')
    expect(socks.requested).toEqual(['100.114.161.62:8000'])
    expect(upstream.seen).toEqual({ path: '/v1/models', host: '100.114.161.62:8000', auth: 'Bearer local-ai-no-key' })
  })

  test('lets the proxy resolve MagicDNS names and streams the response body', async () => {
    const { gateway, socks } = await fixture()
    const answer = await call(gateway.port, '/tailnet/mac.tail2f40bf.ts.net:8000/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-local', stream: true }),
    })
    expect(socks.requested).toEqual(['mac.tail2f40bf.ts.net:8000'])
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('"echo":"qwen-local"')
    expect(answer.body).toContain('[DONE]')
    expect(answer.chunks).toBeGreaterThan(1)
  })

  test('refuses non-tailnet targets without opening a proxy connection', async () => {
    const { gateway, socks } = await fixture()
    for (const path of ['/tailnet/192.168.2.200:8000/v1/models', '/tailnet/127.0.0.1:22/', '/tailnet/example.com:80/']) {
      const answer = await call(gateway.port, path)
      expect(answer.status, path).toBe(403)
    }
    expect((await call(gateway.port, '/v1/models')).status).toBe(404)
    expect(socks.requested).toEqual([])
  })

  test('refuses browser-origin and rebound-host requests before contacting the proxy', async () => {
    const { gateway, socks } = await fixture()
    const path = '/tailnet/100.114.161.62:8000/v1/models'
    expect((await call(gateway.port, path, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call(gateway.port, path, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call(gateway.port, path, { headers: { host: `rebind.example:${String(gateway.port)}` } })).status).toBe(403)
    expect(socks.requested).toEqual([])
    expect((await call(gateway.port, path)).status).toBe(200)
  })

  test('reports an unreachable proxy as a 502 that names it', async () => {
    const free = createTcpServer()
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve))
    const deadPort = (free.address() as AddressInfo).port
    await new Promise<void>(resolve => free.close(() => resolve()))
    const gateway = await startTailnetGateway({ port: 0, proxy: `socks5://127.0.0.1:${String(deadPort)}` })
    cleanups.push(() => gateway.close())
    const answer = await call(gateway.port, '/tailnet/100.114.161.62:8000/v1/models')
    expect(answer.status).toBe(502)
    expect(JSON.parse(answer.body).error.message).toContain(`socks5://127.0.0.1:${String(deadPort)}`)
  })

  test('listens on loopback only and names a taken port', async () => {
    const { gateway } = await fixture()
    await expect(startTailnetGateway({ port: gateway.port, proxy: 'socks5://127.0.0.1:1055' }))
      .rejects.toThrow(`port ${String(gateway.port)} on 127.0.0.1 is already in use`)
  })

  test('close releases the port', async () => {
    const first = await startTailnetGateway({ port: 0, proxy: 'socks5://127.0.0.1:1055' })
    const port = first.port
    await first.close()
    const second = await startTailnetGateway({ port, proxy: 'socks5://127.0.0.1:1055' })
    cleanups.push(() => second.close())
    expect(second.port).toBe(port)
  })

  test('accepts only SOCKS5 proxy addresses and resolves names remotely', () => {
    expect(proxyAgentURL('socks5://127.0.0.1:1055')).toBe('socks5h://127.0.0.1:1055')
    expect(() => proxyAgentURL('http://127.0.0.1:1055')).toThrow('socks5://')
  })
})
