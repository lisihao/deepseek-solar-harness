import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  claudeAuthenticationFailureCode,
  claudeCompactPrompt,
  claudeNativeToolOptions,
  claudeResultFailure,
  ClaudeCodeResidentDriver,
  codexExecutionFailure,
  collectCodexModelsAndQuota,
  CodexResidentDriver,
  createClaudeRlmMcpServer,
  createCodexRlmToolHandler,
  isClaudeNativeSubscription,
  nativeToolSystemPrompt,
  residentClaudeObservations,
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
  it('classifies owner-actionable native login failures without starting a login', () => {
    expect(claudeAuthenticationFailureCode(new Error(
      'connect ECONNREFUSED 127.0.0.1:51000 while delivering OAuth callback',
    ))).toBe('CALLBACK_LISTENER_MISSING')
    expect(claudeAuthenticationFailureCode(new Error(
      'fetch failed: getaddrinfo EAI_AGAIN api.anthropic.com',
    ))).toBe('NETWORK_UNAVAILABLE')
    expect(claudeAuthenticationFailureCode(new Error(
      'Claude Code is not authenticated; run claude auth login',
    ))).toBe('AUTH_REQUIRED')
  })

  it.runIf(process.platform !== 'win32')('starts explicit login with the resolved CLI and a credential-scrubbed environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-claude-auth-'))
    const executable = join(root, 'claude')
    const marker = join(root, 'invocation.txt')
    const previousPath = process.env.PATH
    const previousMarker = process.env.TEST_CLAUDE_AUTH_MARKER
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    class QualifiedAfterLoginDriver extends ClaudeCodeResidentDriver {
      override qualify() {
        return Promise.resolve({
          operatorId: 'claude-code',
          product: 'claude-code',
          displayName: 'Claude Code',
          description: 'Test provider',
          tags: ['subscription'],
          maxConcurrency: 1,
          injectionBoundaries: ['pre-dispatch'] as const,
          available: true,
          authentication: 'native-subscription' as const,
          productVersion: 'test',
          protocolHash: 'test',
          models: [],
        })
      }
    }
    try {
      writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s\' "$*" "${ANTHROPIC_API_KEY-unset}" > "$TEST_CLAUDE_AUTH_MARKER"\n')
      chmodSync(executable, 0o700)
      process.env.PATH = root
      process.env.TEST_CLAUDE_AUTH_MARKER = marker
      process.env.ANTHROPIC_API_KEY = 'must-not-leak'

      await expect(new QualifiedAfterLoginDriver().authenticate()).resolves.toMatchObject({ available: true })
      expect(readFileSync(marker, 'utf8')).toBe('auth login|unset')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousMarker === undefined) delete process.env.TEST_CLAUDE_AUTH_MARKER
      else process.env.TEST_CLAUDE_AUTH_MARKER = previousMarker
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  it('removes the Claude native tool surface for a sealed no-tool execution', () => {
    expect(claudeNativeToolOptions('disabled')).toEqual({ tools: [], allowedTools: [] })
    expect(claudeNativeToolOptions('inherit')).toEqual({})
    expect(nativeToolSystemPrompt('DSH authority', 'disabled')).toContain('grants no native tool authority')
    expect(nativeToolSystemPrompt('DSH authority', 'disabled')).toContain('DSH authority')
    expect(nativeToolSystemPrompt('DSH authority', 'inherit')).toBe('DSH authority')
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

  it('serves a generic DSH tool envelope through the Agent SDK MCP adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-claude-tools-'))
    const socketPath = localIpcAddress(root, 'bridge')
    const bridgeServer = createServer((socket) => {
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.onRequest(() => Promise.resolve({
        isError: false,
        content: [{ type: 'text', text: 'echoed by DSH' }],
        value: { accepted: true },
      }))
      transport.start()
    })
    await new Promise<void>((resolve, reject) => {
      bridgeServer.once('error', reject)
      bridgeServer.listen(socketPath, resolve)
    })
    const server = createClaudeRlmMcpServer('resident-command', {
      version: 1,
      socketPath,
      sessionId: 'agent-session',
      tools: [{
        name: 'echo',
        description: 'Echo through DSH.',
        inputSchema: {
          type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
        },
      }],
    }, new AbortController().signal)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'resident-driver-test', version: '1.0.0' })
    try {
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      await expect(client.callTool({ name: 'echo', arguments: { value: 'hello' } })).resolves.toEqual({
        content: [{ type: 'text', text: 'echoed by DSH\n{"value":{"accepted":true}}' }],
      })
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

describe('Claude Code resident trace normalization', () => {
  it('keeps public text and tool lifecycle while excluding thinking and raw tool result content', () => {
    const toolNames = new Map<string, string>()
    expect(residentClaudeObservations({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private reasoning must never persist' },
          { type: 'text', text: 'I will inspect the package boundary.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'cat .env' } },
        ],
      },
    }, toolNames)).toEqual([
      { kind: 'public-output', preview: 'I will inspect the package boundary.' },
      { kind: 'tool-started', toolName: 'Bash' },
    ])
    expect(residentClaudeObservations({
      type: 'user',
      parent_tool_use_id: 'tool-1',
      message: { content: [{ type: 'tool_result', content: 'DATABASE_PASSWORD=never-persist-this' }] },
    }, toolNames)).toEqual([{ kind: 'tool-completed', toolName: 'Bash' }])
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
