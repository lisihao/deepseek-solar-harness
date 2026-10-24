import { describe, expect, test } from 'vitest'
import {
  LOCAL_AI_KEY_REF,
  fromGatewayBaseURL,
  isTailnetHost,
  modelFromDiscovery,
  normalizeEndpoint,
  parseGatewayPath,
  providerProfile,
  toGatewayBaseURL,
} from '../src/endpoint.js'

describe('normalizeEndpoint', () => {
  test('accepts pasted addresses and canonicalizes them', () => {
    expect(normalizeEndpoint('192.168.2.200:8000/v1')).toBe('http://192.168.2.200:8000/v1')
    expect(normalizeEndpoint(' http://192.168.2.200:8000/v1/ ')).toBe('http://192.168.2.200:8000/v1')
    expect(normalizeEndpoint('https://gpu.example:8443')).toBe('https://gpu.example:8443')
    expect(normalizeEndpoint('http://[fd7a:115c:a1e0::1]:8000/v1')).toBe('http://[fd7a:115c:a1e0::1]:8000/v1')
  })

  test('refuses what cannot be a model endpoint', () => {
    for (const input of ['', '   ', 'ftp://host/v1', 'http://host/v1?x=1', 'http://user:pw@host/v1', 'http://']) {
      expect(normalizeEndpoint(input)).toBeUndefined()
    }
  })
})

describe('isTailnetHost', () => {
  test('accepts the Tailscale CGNAT range, tailnet IPv6 prefix, and MagicDNS', () => {
    for (const host of ['100.64.0.1', '100.114.161.62', '100.127.255.254', '[fd7a:115c:a1e0::3b01:df9f]', 'mac.tail2f40bf.ts.net']) {
      expect(isTailnetHost(host), host).toBe(true)
    }
  })

  test('refuses LAN, loopback, public, and neighbouring ranges', () => {
    for (const host of ['192.168.2.200', '127.0.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8', '::1', 'fd7a:115c:a1e1::1', 'example.com', 'ts.net', 'evil-ts.net']) {
      expect(isTailnetHost(host), host).toBe(false)
    }
  })
})

describe('gateway URL mapping', () => {
  test('round-trips a tailnet endpoint through the loopback gateway', () => {
    const baseURL = toGatewayBaseURL('http://100.114.161.62:8000/v1', 18765)
    expect(baseURL).toBe('http://127.0.0.1:18765/tailnet/100.114.161.62:8000/v1')
    expect(fromGatewayBaseURL(baseURL!)).toEqual({ endpoint: 'http://100.114.161.62:8000/v1', port: 18765 })
  })

  test('keeps MagicDNS names and IPv6 brackets', () => {
    const named = toGatewayBaseURL('mac.tail2f40bf.ts.net:8000/v1', 18765)!
    expect(fromGatewayBaseURL(named)?.endpoint).toBe('http://mac.tail2f40bf.ts.net:8000/v1')
    const v6 = toGatewayBaseURL('http://[fd7a:115c:a1e0::1]:8000/v1', 18765)!
    expect(v6).toBe('http://127.0.0.1:18765/tailnet/[fd7a:115c:a1e0::1]:8000/v1')
    expect(parseGatewayPath(new URL(v6).pathname)).toEqual({ host: '[fd7a:115c:a1e0::1]', port: 8000, path: '/v1' })
  })

  test('only maps http tailnet endpoints', () => {
    expect(toGatewayBaseURL('http://192.168.2.200:8000/v1', 18765)).toBeUndefined()
    expect(toGatewayBaseURL('https://100.114.161.62:8000/v1', 18765)).toBeUndefined()
  })

  test('a direct endpoint is not mistaken for a gateway route', () => {
    expect(fromGatewayBaseURL('http://192.168.2.200:8000/v1')).toBeUndefined()
    expect(fromGatewayBaseURL('http://127.0.0.1:8000/v1')).toBeUndefined()
  })

  test('parses request paths with queries and default ports', () => {
    expect(parseGatewayPath('/tailnet/100.100.1.1:8000/v1/models?limit=5')).toEqual({ host: '100.100.1.1', port: 8000, path: '/v1/models?limit=5' })
    expect(parseGatewayPath('/tailnet/host.ts.net/v1')).toEqual({ host: 'host.ts.net', port: 80, path: '/v1' })
    expect(parseGatewayPath('/tailnet/100.100.1.1:8000')).toEqual({ host: '100.100.1.1', port: 8000, path: '/' })
    expect(parseGatewayPath('/v1/models')).toBeUndefined()
    expect(parseGatewayPath('/tailnet/100.100.1.1:99999/v1')).toBeUndefined()
    expect(parseGatewayPath('/tailnet/')).toBeUndefined()
  })
})

describe('route profile', () => {
  test('copies disclosed discovery facts and drops the rest', () => {
    expect(modelFromDiscovery({ id: 'qwen', name: 'qwen', contextWindow: 262144, inputModalities: ['text', 'audio'] }))
      .toEqual({ id: 'qwen', contextWindow: 262144, input: ['text'] })
    expect(modelFromDiscovery({ id: 'm', name: 'Model M', maxTokens: 4096 })).toEqual({ id: 'm', name: 'Model M', maxTokens: 4096 })
  })

  test('always names the credential reference so a keyless server still gets a placeholder key', () => {
    expect(providerProfile({ displayName: '本地 AI', baseURL: 'http://192.168.2.200:8000/v1', models: [{ id: 'qwen' }] })).toEqual({
      displayName: '本地 AI',
      api: 'openai-completions',
      baseURL: 'http://192.168.2.200:8000/v1',
      apiKeyEnv: LOCAL_AI_KEY_REF,
      models: [{ id: 'qwen' }],
    })
  })
})
