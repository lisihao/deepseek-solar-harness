import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply, inject, normalizeWebpageInstances, parseWebpageTarget, type Config,
} from '../src/index.ts'
import {
  REMOTE_MODULES_SETTINGS_NAMESPACE, parseRemoteModulesConfig, parseWebpageInstances,
} from '../src/contract.ts'

const servers: Server[] = []
const contexts: Context[] = []

class TestSettings extends SettingsProvider {
  readonly writable = true
  private readonly doc: Record<string, unknown>

  constructor(ctx: Context, config: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(config.doc ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
})

async function target(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function harness(config: Config, settingsDocument: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(TestSettings, { doc: settingsDocument }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { ctx, fiber, base: `http://127.0.0.1:${String(ctx.webServer.port)}` }
}

describe('fixed-target Web page relay', () => {
  it('declares durable settings as a required Host service', () => {
    expect(inject).toEqual(['webServer', 'settings'])
  })

  it('accepts HTTP(S) pages with paths but rejects credentials and active URL schemes', () => {
    expect(parseWebpageTarget('url', 'http://127.0.0.1:3000/app?q=1#top').pathname).toBe('/app')
    expect(parseWebpageTarget('url', 'https://example.test/docs').protocol).toBe('https:')
    for (const value of ['not a url', 'ftp://example.test', 'javascript:alert(1)', 'http://u:p@example.test']) {
      expect(() => parseWebpageTarget('url', value)).toThrow(/must be an HTTP\(S\) URL/)
    }
  })

  it('validates every user-settings field before accepting a remote-module configuration', () => {
    const valid = {
      id: 'research-workspace', label: '  Research Workspace  ', url: 'https://example.test/app', relayPort: 0, order: 20,
    }
    expect(parseRemoteModulesConfig({ instances: [valid] })).toEqual({
      instances: [{ ...valid, label: 'Research Workspace' }],
    })
    expect(parseRemoteModulesConfig({ instances: [valid, {
      id: 'model-console', label: 'Model Console', url: 'http://127.0.0.1:19002/console', relayPort: 0, order: 30,
    }] })?.instances).toHaveLength(2)

    const invalid: unknown[] = [
      null,
      [],
      {},
      { instances: [] },
      { instances: 'not-an-array' },
      { instances: [null] },
      { instances: [{ ...valid, id: 1 }] },
      { instances: [{ ...valid, id: 'Not Valid' }] },
      { instances: [valid, { ...valid }] },
      { instances: [{ ...valid, label: 1 }] },
      { instances: [{ ...valid, label: '   ' }] },
      { instances: [{ ...valid, url: 1 }] },
      { instances: [{ ...valid, url: 'not a url' }] },
      { instances: [{ ...valid, url: 'ftp://example.test' }] },
      { instances: [{ ...valid, url: 'https://user:secret@example.test' }] },
      { instances: [{ ...valid, relayPort: '8000' }] },
      { instances: [{ ...valid, relayPort: 1.5 }] },
      { instances: [{ ...valid, relayPort: -1 }] },
      { instances: [{ ...valid, relayPort: 65536 }] },
      { instances: [
        { ...valid, relayPort: 39191 },
        { ...valid, id: 'model-console', relayPort: 39191 },
      ] },
      { instances: [{ ...valid, order: '20' }] },
      { instances: [{ ...valid, order: 20.5 }] },
    ]
    for (const value of invalid) expect(parseRemoteModulesConfig(value)).toBeUndefined()
  })

  it('rejects malformed Host rosters and returns deterministic browser ordering', () => {
    const valid = {
      id: 'research-workspace', label: '  Research Workspace  ', targetUrl: 'https://example.test/app',
      embedUrl: 'http://localhost:39191/app', order: 20,
    }
    expect(parseWebpageInstances({ instances: [
      { ...valid, id: 'model-console', label: 'Model Console', order: 30 },
      valid,
      { ...valid, id: 'alpha', label: 'Alpha', order: 20 },
    ] })).toEqual([
      { ...valid, id: 'alpha', label: 'Alpha' },
      { ...valid, label: 'Research Workspace' },
      { ...valid, id: 'model-console', label: 'Model Console', order: 30 },
    ])

    const invalidEntries: unknown[] = [
      null,
      { ...valid, id: 1 },
      { ...valid, id: 'Not Valid' },
      { ...valid, label: 1 },
      { ...valid, label: '  ' },
      { ...valid, targetUrl: 'ftp://example.test' },
      { ...valid, embedUrl: 'not a url' },
      { ...valid, order: '20' },
      { ...valid, order: 20.5 },
    ]
    expect(() => parseWebpageInstances(null)).toThrow(/invalid instance roster/)
    expect(() => parseWebpageInstances({ instances: 'not-an-array' })).toThrow(/invalid instance roster/)
    for (const candidate of invalidEntries) {
      expect(() => parseWebpageInstances({ instances: [candidate] })).toThrow(/invalid instance at index 0/)
    }
    expect(() => parseWebpageInstances({ instances: [valid, { ...valid }] })).toThrow(/duplicate instance id/)
  })

  it('proxies the actual target page and removes only headers that forbid embedding', async () => {
    const origin = await target((req, res) => {
      expect(req.url).toBe('/app?fixture=1')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'; img-src 'self' data:",
        'set-cookie': 'session=real-page; Domain=example.test; Path=/; HttpOnly',
      })
      res.end('<main>Actual research workspace</main>')
    })
    const app = await harness({ instances: [{
      id: 'research-workspace', label: 'Research Workspace', url: `${origin}/app?fixture=1#workspace`, relayPort: 0, order: 20,
    }] })
    const rosterResponse = await fetch(`${app.base}/remote-webpages/v1/instances`)
    expect(rosterResponse.headers.get('cache-control')).toBe('no-store')
    const roster = await rosterResponse.json() as { instances: Array<{ targetUrl: string; embedUrl: string }> }
    expect(roster.instances[0]!.targetUrl).toBe(`${origin}/app?fixture=1#workspace`)
    expect(roster.instances[0]!.embedUrl).toMatch(/^http:\/\/localhost:\d+\/app\?fixture=1#workspace$/)
    const page = await fetch(roster.instances[0]!.embedUrl)
    expect(await page.text()).toContain('Actual research workspace')
    expect(page.headers.get('x-frame-options')).toBeNull()
    expect(page.headers.get('content-security-policy')).toBe("default-src 'self'; img-src 'self' data:")
    expect(page.headers.get('set-cookie')).toBe('session=real-page; Path=/; HttpOnly')
    expect(page.headers.get('x-dsh-webpage-instance')).toBe('research-workspace')
  })

  it('publishes multiple independently ordered instances and disposes routes plus relays', async () => {
    const workspace = await target((_req, res) => { res.end('Research Workspace page') })
    const console = await target((_req, res) => { res.end('Model Console page') })
    const app = await harness({ instances: [
      { id: 'model-console', label: 'Model Console', url: `${console}/docs`, relayPort: 0, order: 200 },
      { id: 'research-workspace', label: 'Research Workspace', url: workspace, relayPort: 0, order: 100 },
    ] })
    const response = await fetch(`${app.base}/remote-webpages/v1/instances`)
    const roster = await response.json() as { instances: Array<{ id: string; embedUrl: string }> }
    expect(roster.instances.map(item => item.id)).toEqual(['research-workspace', 'model-console'])
    expect((await fetch(roster.instances[0]!.embedUrl)).status).toBe(200)
    expect((await fetch(`${app.base}/remote-webpages/v1/instances`, { method: 'POST' })).status).toBe(405)
    const head = await fetch(`${app.base}/remote-webpages/v1/instances`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const relayUrl = roster.instances[0]!.embedUrl
    await app.fiber.dispose()
    expect((await fetch(`${app.base}/remote-webpages/v1/instances`)).status).toBe(404)
    await expect(fetch(relayUrl)).rejects.toThrow()
  })

  it('boots from the user-settings override and marks the namespace restart-applied', async () => {
    const baseTarget = await target((_req, res) => { res.end('base page') })
    const savedTarget = await target((_req, res) => { res.end('saved page') })
    const base: Config = { instances: [{
      id: 'base', label: 'Base', url: baseTarget, relayPort: 0, order: 100,
    }] }
    const saved: Config = { instances: [{
      id: 'saved', label: 'Saved', url: savedTarget, relayPort: 0, order: 200,
    }] }
    const app = await harness(base, { [REMOTE_MODULES_SETTINGS_NAMESPACE]: saved })
    const roster = await (await fetch(`${app.base}/remote-webpages/v1/instances`)).json() as {
      instances: Array<{ id: string }>
    }
    expect(roster.instances.map(instance => instance.id)).toEqual(['saved'])
    const descriptor = app.ctx.settings.describe().find(candidate =>
      candidate.ns === settingsNamespace(REMOTE_MODULES_SETTINGS_NAMESPACE))
    expect(descriptor).toMatchObject({ applies: 'restart', base, user: saved, value: saved })
  })

  it('fails loud on duplicate ids, duplicate stable ports, and invalid instance ids', async () => {
    const origin = await target((_req, res) => { res.end('page') })
    const base = { label: 'Page', url: origin, relayPort: 0, order: 100 }
    expect(() => normalizeWebpageInstances([
      { ...base, id: 'same' }, { ...base, id: 'same' },
    ])).toThrow(/duplicate instance id/)
    expect(() => normalizeWebpageInstances([
      { ...base, id: 'one', relayPort: 39191 }, { ...base, id: 'two', relayPort: 39191 },
    ])).toThrow(/duplicate relayPort/)
    expect(() => normalizeWebpageInstances([{ ...base, id: 'Not Valid' }])).toThrow(/must be kebab-case/)
    expect(() => normalizeWebpageInstances([{ ...base, id: 'empty-label', label: '  ' }])).toThrow(/must not be empty/)
    expect(() => normalizeWebpageInstances([{ ...base, id: 'fractional-order', order: 1.5 }])).toThrow(/must be an integer/)
    expect(normalizeWebpageInstances([
      { ...base, id: 'zulu', label: '  Zulu  ', order: 100 },
      { ...base, id: 'alpha', label: 'Alpha', order: 100 },
    ]).map(instance => ({ id: instance.id, label: instance.label }))).toEqual([
      { id: 'alpha', label: 'Alpha' }, { id: 'zulu', label: 'Zulu' },
    ])
  })
})
