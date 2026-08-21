import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PrimeAgentResidentDriver } from '../src/index.ts'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/fake-prime-agent.mjs', import.meta.url))

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-prime-driver-'))
  roots.push(value)
  return value
}

function auth(path: string, type: 'oauth' | 'api_key'): string {
  const value = join(path, 'auth.json')
  writeFileSync(value, JSON.stringify({ 'openai-codex': { type, access: 'not-a-real-token' } }), { mode: 0o600 })
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('PrimeAgentResidentDriver', () => {
  it('resolves the pinned ESM package CLI without a CommonJS export', async () => {
    const stateRoot = root()
    const driver = new PrimeAgentResidentDriver({ stateRoot, authPath: auth(stateRoot, 'api_key') })
    await expect(driver.qualify()).resolves.toMatchObject({
      productVersion: '0.7.4',
      authentication: 'unqualified',
    })
  })

  it('requires openai-codex OAuth and exposes only subscription models', async () => {
    const stateRoot = root()
    const apiDriver = new PrimeAgentResidentDriver({ stateRoot, cliPath: fixture, authPath: auth(stateRoot, 'api_key') })
    await expect(apiDriver.qualify()).resolves.toMatchObject({
      available: false,
      authentication: 'unqualified',
    })

    const oauthDriver = new PrimeAgentResidentDriver({ stateRoot, cliPath: fixture, authPath: auth(stateRoot, 'oauth') })
    await expect(oauthDriver.qualify()).resolves.toMatchObject({
      available: true,
      authentication: 'native-subscription',
      productVersion: '0.7.4',
      models: [{ model: 'gpt-5.5', isDefault: true }],
    })
    expect((await oauthDriver.qualify()).models).toHaveLength(1)
  })

  it('persists the native Prime session across turns and scrubs API credentials', async () => {
    const stateRoot = root()
    const workspace = join(stateRoot, 'workspace')
    mkdirSync(workspace)
    const driver = new PrimeAgentResidentDriver({ stateRoot, cliPath: fixture, authPath: auth(stateRoot, 'oauth') })
    const profile = { model: 'gpt-5.5', effort: 'high' as const }
    const firstRunning: string[] = []
    const first = await driver.execute({
      workspace,
      prompt: [{ type: 'text', text: 'first node turn' }],
      profile,
      signal: new AbortController().signal,
      onRunning: (nativeSessionId) => { if (nativeSessionId !== undefined) firstRunning.push(nativeSessionId) },
      onProgress: () => {},
    })
    expect(first.nativeSessionId).toBe('prime-session-1')
    expect(firstRunning).toEqual(['prime-session-1'])
    expect(first.output).toEqual([{ type: 'text', text: 'session=prime-session-1;count=1;authority=true;api=false' }])

    const second = await driver.execute({
      workspace,
      prompt: [{ type: 'text', text: 'second node turn' }],
      profile,
      nativeSessionId: first.nativeSessionId,
      signal: new AbortController().signal,
      onRunning: () => {},
      onProgress: () => {},
    })
    expect(second.nativeSessionId).toBe(first.nativeSessionId)
    expect(second.output).toEqual([{ type: 'text', text: 'session=prime-session-1;count=2;authority=true;api=false' }])
  })
})
