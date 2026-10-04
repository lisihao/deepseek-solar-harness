import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { followsPublicAlias, startWebpageRelay, type WebpageRelay } from '../src/relay.ts'

const servers: Server[] = []
const relays: WebpageRelay[] = []

afterEach(async () => {
  await Promise.allSettled(relays.splice(0).map(async (relay) => { await relay.close() }))
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
})

async function origin(handler: RequestListener, host = '127.0.0.1'): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => { server.off('error', reject); resolve() })
  })
  return `http://${host}:${String((server.address() as AddressInfo).port)}`
}

async function relay(targetUrl: string, followsRedirect?: (from: URL, to: URL) => boolean): Promise<WebpageRelay> {
  const started = await startWebpageRelay({
    id: 'alias', targetUrl, port: 0, ...(followsRedirect === undefined ? {} : { followsRedirect }),
  })
  relays.push(started)
  return started
}

function get(url: string): Promise<Response> {
  return fetch(url, { redirect: 'manual' })
}

describe('followsPublicAlias', () => {
  const url = (value: string): URL => new URL(value)

  it('follows only between public DNS names without credentials', () => {
    expect(followsPublicAlias(url('http://www.x.com'), url('https://twitter.com/'))).toBe(true)
    expect(followsPublicAlias(url('https://x.com'), url('https://user:pw@x.com/'))).toBe(false)
    expect(followsPublicAlias(url('https://x.com'), url('https://:pw@x.com/'))).toBe(false)
  })

  it.each([
    'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://localhost:3000', 'http://app.localhost',
    'http://mini.local', 'http://intranet', 'http://10.0.0.5',
  ])('never moves from or to %s', (internal) => {
    expect(followsPublicAlias(url(internal), url('https://x.com/'))).toBe(false)
    expect(followsPublicAlias(url('https://x.com'), url(internal))).toBe(false)
  })
})

describe('relay redirect handling', () => {
  it('leaves a redirect to another origin untouched when the rule declines it', async () => {
    const elsewhere = await origin((_req, res) => { res.end('elsewhere') }, 'localhost')
    const home = await origin((_req, res) => { res.writeHead(302, { location: `${elsewhere}/landing` }); res.end() })
    const started = await relay(home)
    const response = await get(started.embedUrl)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${elsewhere}/landing`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('follows the target site to its alias, rewrites the redirect to the relay, and never caches it', async () => {
    const alias = await origin((req, res) => { res.end(`alias served ${req.url ?? ''}`) }, 'localhost')
    const home = await origin((_req, res) => { res.writeHead(301, { location: `${alias}/` }); res.end() })
    const started = await relay(home, () => true)
    const redirect = await get(started.embedUrl)
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toMatch(/^http:\/\/localhost:\d+\/$/)
    expect(redirect.headers.get('cache-control')).toBe('no-store')
    const landed = await get(`${started.embedUrl.replace(/\/$/, '')}/page?q=1`)
    expect(await landed.text()).toBe('alias served /page?q=1')
  })

  it.each([
    ['//', '//'],
    ['backslashes, which a browser also reads as protocol-relative', '\\\\'],
  ])('resolves a protocol-relative destination with %s against the current target before deciding', async (_name, slashes) => {
    const alias = await origin((req, res) => { res.end(`alias served ${req.url ?? ''}`) }, 'localhost')
    const authority = alias.replace('http:', '')
    const home = await origin((_req, res) => { res.writeHead(302, { location: `${slashes}${authority.slice(2)}/landing` }); res.end() })
    const started = await relay(home, () => true)
    const redirect = await get(started.embedUrl)
    // The destination is the alias, which the rule accepts, so the browser is sent back through the relay.
    expect(redirect.headers.get('location')).toMatch(/^http:\/\/localhost:\d+\/landing$/)
    expect(redirect.headers.get('location')).not.toContain(authority.slice(2).split('/')[0]!.replace(/^localhost/, 'other'))
    const landed = await get(`${started.embedUrl.replace(/\/$/, '')}/landing`)
    expect(await landed.text()).toBe('alias served /landing')
  })

  it('names a declined protocol-relative destination in full, with the target scheme, so the browser cannot reinterpret it', async () => {
    const elsewhere = await origin((_req, res) => { res.end('elsewhere') }, 'localhost')
    const home = await origin((_req, res) => { res.writeHead(302, { location: `${elsewhere.replace('http:', '')}/landing` }); res.end() })
    const started = await relay(home)
    const redirect = await get(started.embedUrl)
    expect(redirect.headers.get('location')).toBe(`${elsewhere}/landing`)
  })

  it('keeps an upstream cache policy on a redirect', async () => {
    const home = await origin((_req, res) => {
      res.writeHead(307, { location: '/next', 'cache-control': 'max-age=60' })
      res.end()
    })
    const response = await get((await relay(home)).embedUrl)
    expect(response.headers.get('cache-control')).toBe('max-age=60')
  })

  it.each([
    ['a non-redirect status', 200, 'http://other.invalid/'],
    ['a redirect without a destination', 302, undefined],
    ['an unparseable destination', 302, 'http://['],
    ['a non-HTTP destination', 302, 'ftp://other.invalid/'],
    ['a redirect to its own origin', 302, 'SELF'],
  ])('does not move for %s', async (_name, status, location) => {
    let self = ''
    let hits = 0
    const home = await origin((_req, res) => {
      hits += 1
      res.writeHead(status, location === undefined ? {} : { location: location === 'SELF' ? `${self}/again` : location })
      res.end('body')
    })
    self = home
    const started = await relay(home, () => true)
    await get(started.embedUrl)
    await get(started.embedUrl)
    expect(hits).toBe(2)
  })

  it('stops following after eight origin changes so a redirect loop cannot move the target forever', async () => {
    let first = ''
    let second = ''
    const a = await origin((_req, res) => { res.writeHead(302, { location: `${second}/` }); res.end() })
    const b = await origin((_req, res) => { res.writeHead(302, { location: `${first}/` }); res.end() }, 'localhost')
    first = a
    second = b
    const started = await relay(a, () => true)
    const locations: string[] = []
    for (let step = 0; step < 10; step++) locations.push((await get(started.embedUrl)).headers.get('location') ?? '')
    expect(locations.slice(0, 8).every(location => location.startsWith('http://localhost:'))).toBe(true)
    expect(locations[8]).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/$/)
    expect(locations.filter(location => location.startsWith(first) || location.startsWith(second))).toHaveLength(2)
  })
})
