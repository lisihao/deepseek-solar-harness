import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it } from 'vitest'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  claudeEnvironment,
  claudeCompactPrompt,
  claudeResultFailure,
  codexExecutionFailure,
  collectCodexModelsAndQuota,
  CodexResidentDriver,
  createClaudeRlmMcpServer,
  createCodexRlmToolHandler,
  isClaudeNativeSubscription,
  resolveProductExecutable,
} from '../src/drivers.ts'

const model = {
  id: 'sol',
  model: 'gpt-5.6-sol',
  displayName: 'Sol',
  description: 'Frontier coding model',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
} as const

describe('Claude Code resident driver environment', () => {
  it('uses Claude Code native /compact and preserves optional instructions', () => {
    expect(claudeCompactPrompt()).toBe('/compact')
    expect(claudeCompactPrompt('retain architectural decisions')).toBe('/compact retain architectural decisions')
  })

  it('accepts the first-party claude.ai status emitted with a null subscription type', () => {
    expect(isClaudeNativeSubscription({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: null,
    })).toBe(true)
  })

  it('rejects non-claude.ai and non-first-party authentication', () => {
    expect(isClaudeNativeSubscription({
      loggedIn: true,
      authMethod: 'apiKey',
      apiProvider: 'firstParty',
    })).toBe(false)
    expect(isClaudeNativeSubscription({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'thirdParty',
    })).toBe(false)
  })

  it('uses the macOS system CA store without changing the parent environment', () => {
    const parent = { PATH: '/usr/bin:/bin' }
    expect(claudeEnvironment(parent, 'darwin')).toEqual({
      PATH: '/usr/bin:/bin',
      NODE_USE_SYSTEM_CA: '1',
    })
    expect(parent).toEqual({ PATH: '/usr/bin:/bin' })
  })

  it('preserves an explicit caller CA policy and does not change other platforms', () => {
    expect(claudeEnvironment({ NODE_USE_SYSTEM_CA: '0' }, 'darwin')).toEqual({ NODE_USE_SYSTEM_CA: '0' })
    expect(claudeEnvironment({ PATH: '/usr/bin' }, 'linux')).toEqual({ PATH: '/usr/bin' })
  })

  it('pins SDK execution to the same first user-owned CLI selected for qualification', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-claude-cli-'))
    const preferred = join(root, 'preferred')
    const legacy = join(root, 'legacy')
    const executableName = process.platform === 'win32' ? 'claude.CMD' : 'claude'
    const executable = process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n'
    const preferredClaude = join(preferred, executableName)
    const legacyClaude = join(legacy, executableName)
    try {
      mkdirSync(preferred)
      mkdirSync(legacy)
      writeFileSync(preferredClaude, executable)
      writeFileSync(legacyClaude, executable)
      chmodSync(preferredClaude, 0o700)
      chmodSync(legacyClaude, 0o700)

      const resolved = resolveProductExecutable(
        'claude',
        { PATH: `${preferred}${delimiter}${legacy}` },
        process.platform,
      )
      expect(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
        .toBe(process.platform === 'win32' ? preferredClaude.toLowerCase() : preferredClaude)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Claude Code RLM host tool', () => {
  it('serves typescript_repl through the Agent SDK MCP adapter with a stable Receipt identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-claude-rlm-'))
    const socketPath = localIpcAddress(root, 'bridge')
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const bridgeServer = createServer((socket) => {
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.onRequest((method, params) => {
        requests.push({ method, params })
        return Promise.resolve({ value: 42 })
      })
      transport.start()
    })
    await new Promise<void>((resolve, reject) => {
      bridgeServer.once('error', reject)
      bridgeServer.listen(socketPath, resolve)
    })
    const server = createClaudeRlmMcpServer('resident-command', {
      version: 1,
      socketPath,
      sessionId: 'rlm-session',
      tools: [{
        name: 'typescript_repl',
        description: 'Execute one persistent TypeScript cell.',
        inputSchema: {
          type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
        },
      }],
    }, new AbortController().signal)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'resident-driver-test', version: '1.0.0' })
    try {
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      await expect(client.callTool({ name: 'typescript_repl', arguments: { code: '40 + 2' } })).resolves.toEqual({
        content: [{ type: 'text', text: '{"value":42}' }],
      })
      expect(requests).toEqual([{
        method: 'tool.call',
        params: {
          session_id: 'rlm-session',
          command_id: 'resident-command:claude-tool:1',
          tool: 'typescript_repl',
          arguments: { code: '40 + 2' },
        },
      }])
    } finally {
      await client.close()
      await server.instance.close()
      await new Promise<void>((resolve) => { bridgeServer.close(() => { resolve() }) })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Codex RLM host tool', () => {
  it('maps an app-server dynamic tool call to the same owner-local bridge with a stable Receipt identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-rlm-'))
    const socketPath = localIpcAddress(root, 'bridge')
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const bridgeServer = createServer((socket) => {
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.onRequest((method, params) => {
        requests.push({ method, params })
        return Promise.resolve({ value: 42 })
      })
      transport.start()
    })
    await new Promise<void>((resolve, reject) => {
      bridgeServer.once('error', reject)
      bridgeServer.listen(socketPath, resolve)
    })
    const handler = createCodexRlmToolHandler('resident-command', {
      version: 1,
      socketPath,
      sessionId: 'rlm-session',
      tools: [{ name: 'typescript_repl', description: 'Execute TypeScript.', inputSchema: { type: 'object' } }],
    }, new AbortController().signal)
    try {
      await expect(handler({
        threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
        tool: 'typescript_repl', arguments: { code: '40 + 2' },
      })).resolves.toEqual({ success: true, text: '{"value":42}' })
      expect(requests).toEqual([{
        method: 'tool.call',
        params: {
          session_id: 'rlm-session',
          command_id: 'resident-command:codex-tool:call-1',
          tool: 'typescript_repl',
          arguments: { code: '40 + 2' },
        },
      }])
    } finally {
      await new Promise<void>((resolve) => { bridgeServer.close(() => { resolve() }) })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Claude Code resident terminal failures', () => {
  it('classifies an expired native subscription as an authentication failure', () => {
    const failure = claudeResultFailure({
      type: 'result', subtype: 'success', is_error: true,
      result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
    } as SDKResultMessage)
    expect(failure).toMatchObject({ code: 'AUTH_MODE_MISMATCH' })
    expect(failure?.message).toContain('claude auth login')
  })

  it('classifies certificate verification as runtime unavailability', () => {
    const failure = claudeResultFailure({
      type: 'result', subtype: 'success', is_error: true,
      result: 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)',
    } as SDKResultMessage)
    expect(failure).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('accepts a successful final result', () => {
    expect(claudeResultFailure({
      type: 'result', subtype: 'success', is_error: false, result: 'ok',
    } as SDKResultMessage)).toBeUndefined()
  })

  it('classifies a subscription allowance failure as quota exhaustion', () => {
    expect(claudeResultFailure({
      type: 'result', subtype: 'success', is_error: true,
      result: 'Usage limit reached. Try again after the subscription window resets.',
    } as SDKResultMessage)).toMatchObject({ code: 'QUOTA_EXHAUSTED' })
  })
})

describe('Codex Resident catalog qualification', () => {
  it('rejects unsupported compaction instructions before touching native transport', async () => {
    await expect(new CodexResidentDriver().compact({
      workspace: '/workspace',
      nativeSessionId: 'thread-1',
      instructions: 'retain architecture decisions',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  })

  it('classifies a disconnected response stream as retryable runtime unavailability', () => {
    expect(codexExecutionFailure(new Error(
      'subagent-codex: Codex turn ended with status failed: {"message":"stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"}',
    ))).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('classifies a native subscription usage limit as quota exhaustion', () => {
    expect(codexExecutionFailure(new Error(
      'subagent-codex: Codex turn ended with status failed: {"message":"You have hit your usage limit","codexErrorInfo":"usageLimitExceeded"}',
    ))).toMatchObject({ code: 'QUOTA_EXHAUSTED' })
  })

  it('keeps execution qualified when only quota telemetry is unavailable', async () => {
    const result = await collectCodexModelsAndQuota(
      async () => [model],
      async () => { throw new Error('usage endpoint unavailable') },
      '2026-08-22T00:00:00.000Z',
    )

    expect(result.models).toEqual([expect.objectContaining({ model: 'gpt-5.6-sol', isDefault: true })])
    expect(result.quotaPools).toEqual([])
    expect(result.quotaUnavailableReason).toContain('usage endpoint unavailable')
  })

  it('maps independently metered standard and Spark pools when telemetry is available', async () => {
    const result = await collectCodexModelsAndQuota(
      async () => [model, { ...model, id: 'spark', model: 'gpt-5.3-codex-spark', displayName: 'Spark' }],
      async () => [
        { limitId: 'codex', primary: { usedPercent: 20 } },
        { limitId: 'codex_bengalfox', limitName: 'Spark', primary: { usedPercent: 10 } },
      ],
      '2026-08-22T00:00:00.000Z',
    )

    expect(result.quotaUnavailableReason).toBeUndefined()
    expect(result.quotaPools).toEqual([
      expect.objectContaining({ poolId: 'codex', models: ['gpt-5.6-sol'] }),
      expect.objectContaining({ poolId: 'codex_bengalfox', models: ['gpt-5.3-codex-spark'] }),
    ])
  })
})
