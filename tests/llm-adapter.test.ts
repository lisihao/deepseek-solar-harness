import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  serializeConversationRequest,
  WebLlmAdapter,
  WEB_LLM_MAX_PROMPT_BYTES,
  WEB_LLM_MODEL,
  WEB_LLM_NAME,
  WEB_LLM_PROVIDER,
} from '../incubator/chatgpt-web/src/llm-adapter.js'
import type { WebLlmController } from '../incubator/chatgpt-web/src/llm-adapter.js'
import type { WebRunRecord, WebRunRequest } from '../incubator/chatgpt-web/src/store.js'

const sessionId = 'session-llm-adapter' as GenerateOptions['sessionId']

function record(
  id: string,
  request: WebRunRequest,
  stage: WebRunRecord['stage'] = 'completed',
  overrides: Partial<WebRunRecord> = {},
): WebRunRecord {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return {
    formatVersion: 1,
    id,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    request,
    stage,
    ...overrides,
  }
}

function fakeController(overrides: Partial<{
  start: WebLlmController['start']
  observe: WebLlmController['observe']
}> = {}): WebLlmController & {
  start: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
} {
  const value = {
    start: vi.fn(async (id: string, request: WebRunRequest) => record(id, request, 'completed', {
      output: { text: 'plain', markdown: '**网页回答**' },
    })),
    observe: vi.fn(async (id: string) => record(id, { prompt: 'observed' }, 'completed', {
      output: { text: 'plain', markdown: 'observed answer' },
    })),
    ...overrides,
  }
  return value as WebLlmController & { start: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: WEB_LLM_PROVIDER,
    model: WEB_LLM_MODEL,
    sessionId,
    messages: [{
      id: 'user-1' as never,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请用 Markdown 回答。' }],
    }],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('WebLlmAdapter', () => {
  it('advertises the public provider, one catalog model, and no automatic retries', async () => {
    const adapter = new WebLlmAdapter(fakeController(), { modelLabel: 'GPT-6', effortLabel: 'medium' })
    expect(adapter.providerInfo(WEB_LLM_PROVIDER)).toEqual({ id: WEB_LLM_PROVIDER, name: WEB_LLM_NAME })
    await expect(adapter.listModels(WEB_LLM_PROVIDER)).resolves.toEqual([
      { provider: WEB_LLM_PROVIDER, id: WEB_LLM_MODEL, name: WEB_LLM_NAME },
    ])
    expect(adapter.providerRetryPolicy(WEB_LLM_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 0 })
    const policy = adapter.providerRetryPolicy(WEB_LLM_PROVIDER)
    expect(policy.mode).toBe('normal')
    if (policy.mode === 'normal') expect(policy.retryableCodes.length).toBeGreaterThan(0)
  })

  it('registers through the public rc.2 LlmRuntime and captures maxRetries=0', () => {
    const adapter = new WebLlmAdapter(fakeController())
    const runtime = new LlmRuntime(new Context())
    const unregister = runtime.registerAdapter([WEB_LLM_PROVIDER], adapter)
    expect(runtime.listProviders()).toEqual([{ id: WEB_LLM_PROVIDER, name: WEB_LLM_NAME }])
    expect(runtime.providerRetryPolicy(WEB_LLM_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 0 })
    unregister()
  })

  it('serializes complete roles, system context, labels, and historical tool data while omitting reasoning', async () => {
    const fake = fakeController()
    const adapter = new WebLlmAdapter(fake, { modelLabel: 'GPT-6', effortLabel: 'medium' })
    const hidden = 'do not send hidden reasoning'
    const input = options({
      system: '保持正式语气并保留 Markdown。',
      reasoningEffort: 'high' as never,
      messages: [
        {
          id: 'user-1' as never,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '用户上下文' }],
        },
        {
          id: 'assistant-1' as never,
          role: 'assistant',
          source: { kind: 'model', provider: 'other', model: 'other-model' },
          content: [
            { type: 'reasoning', text: hidden },
            { type: 'text', text: '助手历史' },
            { type: 'tool-call', id: 'call-1' as never, name: 'never-run', arguments: '{"x":1}' },
          ],
        },
        {
          id: 'tool-1' as never,
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' as never },
          toolCallId: 'call-1' as never,
          isError: false,
          content: [{ type: 'text', text: '工具历史结果' }],
        },
      ] as GenerateOptions['messages'],
    })

    await collect(adapter.stream(input))
    const prompt = fake.start.mock.calls[0]?.[1].prompt as string
    expect(prompt).toContain('[message system role=system id=request-system]')
    expect(prompt).toContain('role=user id=user-1')
    expect(prompt).toContain('role=assistant id=assistant-1')
    expect(prompt).toContain('role=tool id=tool-1')
    expect(prompt).toContain('用户上下文')
    expect(prompt).toContain('助手历史')
    expect(prompt).toContain('工具历史结果')
    expect(prompt).toContain('never-run')
    expect(prompt).toContain('never execute')
    expect(prompt).toContain('Preserve Markdown')
    expect(prompt).not.toContain(hidden)
    expect(prompt).toContain('high')
    expect(fake.start).toHaveBeenCalledOnce()
  })

  it('captures the exact serialized request before start and blocks the browser when capture fails', async () => {
    const events: string[] = []
    const fake = fakeController({
      start: vi.fn(async (id, request) => {
        events.push(`start:${id}`)
        return record(id, request, 'completed', { output: { text: '', markdown: 'done' } })
      }),
    })
    const captured: Array<{ id: string; sessionId: string; request: WebRunRequest }> = []
    const adapter = new WebLlmAdapter(fake, {
      modelLabel: 'GPT-6',
      onRequest: async (input) => {
        events.push(`capture:${input.id}`)
        captured.push(input)
      },
    })
    await collect(adapter.stream(options()))
    expect(events[0]).toMatch(/^capture:/)
    expect(events[1]).toBe(`start:${captured[0]?.id}`)
    expect(captured[0]?.sessionId).toBe(sessionId)
    expect(captured[0]?.request.prompt).toContain('请用 Markdown 回答。')

    const blocked = fakeController()
    const rejected = new WebLlmAdapter(blocked, { onRequest: async () => { throw new Error('capture failed') } })
    await expect(collect(rejected.stream(options()))).rejects.toMatchObject({ code: 'WEB_REQUEST_CAPTURE_FAILED' })
    expect(blocked.start).not.toHaveBeenCalled()
  })

  it('exports the same bounded pure serializer used for durable identity', () => {
    const serialized = serializeConversationRequest(options(), { modelLabel: 'GPT-6', effortLabel: 'medium' })
    expect(serialized.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(serialized.canonical).toContain('user-1')
    expect(serialized.prompt).toContain('GPT-6')
    expect(Buffer.byteLength(serialized.prompt, 'utf8')).toBeLessThanOrEqual(128 * 1024)
  })

  it('projects only marked Harness background while retaining ordered portable conversation context', async () => {
    const harnessSystem = `system-envelope-marker:${'S'.repeat(140 * 1024)}`
    const skillCatalog = `skill-catalog-marker:${'C'.repeat(401 * 1024)}`
    const input = options({
      messages: [
        {
          id: 'harness-system' as never,
          role: 'system',
          source: { kind: 'system-prompt', sections: [{ name: 'system-section-marker', text: harnessSystem }] } as never,
          content: [{ type: 'text', text: harnessSystem }],
        },
        {
          id: 'skill-catalog' as never,
          role: 'user',
          source: {
            kind: 'skill-catalog',
            form: 'catalog',
            entries: [{ id: 'catalog-entry-marker', text: skillCatalog }],
          } as never,
          content: [{ type: 'text', text: skillCatalog }],
        },
        {
          id: 'runtime-context' as never,
          role: 'user',
          source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'runtime', text: 'runtime-section-marker' }] } as never,
          content: [{ type: 'text', text: 'RUNTIME CONTEXT MARKER' }],
        },
        {
          id: 'time-context' as never,
          role: 'user',
          source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time', text: 'time-section-marker' }] } as never,
          content: [{ type: 'text', text: 'TIME CONTEXT MARKER' }],
        },
        {
          id: 'memory-context' as never,
          role: 'user',
          source: { kind: 'memory', form: 'recall', entries: ['memory-entry-marker'] } as never,
          content: [{ type: 'text', text: 'MEMORY CONTEXT MARKER' }],
        },
        {
          id: 'hindsight-recall' as never,
          role: 'user',
          source: { kind: 'plugin:hindsight', form: 'recall', entries: ['hindsight-recall-entry-marker'] } as never,
          content: [{ type: 'text', text: 'HINDSIGHT RECALL MARKER' }],
        },
        {
          id: 'mnemon-recall' as never,
          role: 'user',
          source: { kind: 'dsh-mnemon', form: 'recall', entries: ['mnemon-recall-entry-marker'] } as never,
          content: [{ type: 'text', text: 'MNEMON RECALL MARKER' }],
        },
        {
          id: 'plugin-catalog' as never,
          role: 'user',
          source: { kind: 'plugin', form: 'catalog', entries: ['plugin-catalog-entry-marker'] } as never,
          content: [{ type: 'text', text: 'PLUGIN CATALOG MARKER' }],
        },
        {
          id: 'graph-memory-snapshot' as never,
          role: 'user',
          source: { kind: 'plugin:graph-memory', form: 'snapshot', entries: ['graph-memory-entry-marker'] } as never,
          content: [{ type: 'text', text: 'GRAPH MEMORY SNAPSHOT MARKER' }],
        },
        {
          id: 'graph-memory-instructions' as never,
          role: 'user',
          source: { kind: 'plugin:graph-memory', form: 'instructions', entries: ['graph-memory-instruction-marker'] } as never,
          content: [{ type: 'text', text: 'GRAPH MEMORY INSTRUCTIONS RETAIN MARKER' }],
        },
        {
          id: 'unknown-system' as never,
          role: 'system',
          source: { kind: 'unknown-system-producer', form: 'snapshot', sections: [{ name: 'unknown', text: 'unknown-source-section-marker' }] } as never,
          content: [{ type: 'text', text: 'UNKNOWN SYSTEM MESSAGE: retain this exact text.' }],
        },
        {
          id: 'workspace-instructions' as never,
          role: 'user',
          source: {
            kind: 'dsh-mnemon',
            form: 'instructions',
            entries: [{ id: 'instruction-entry-marker', text: 'unrelated source metadata' }],
          } as never,
          content: [{ type: 'text', text: 'DSH MNEMON TOOL INSTRUCTION: filter this native instruction.' }],
        },
        {
          id: 'actual-user' as never,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'EXACT USER CONSTRAINT: answer in Chinese and preserve numbers.' }],
        },
        {
          id: 'historic-assistant' as never,
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'other',
            model: 'other-model',
            replayState: { marker: 'replay-state-marker' },
          },
          content: [{ type: 'tool-call', id: 'history-call' as never, name: 'historical-tool', arguments: '{"order":1}' }],
        },
        {
          id: 'historic-tool-result' as never,
          role: 'tool',
          source: { kind: 'tool', callId: 'history-call' as never },
          toolCallId: 'history-call' as never,
          isError: true,
          content: [{ type: 'text', text: 'HISTORICAL TOOL ERROR: unavailable result.' }],
        },
        {
          id: 'task-notice' as never,
          role: 'user',
          source: { kind: 'task', form: 'notice', summary: 'task notice', entries: ['task-entry-marker'] } as never,
          content: [{ type: 'text', text: 'TASK NOTICE: retain the open task context.' }],
        },
        {
          id: 'compact-checkpoint' as never,
          role: 'user',
          source: { kind: 'compact-checkpoint', form: 'notice', summary: 'checkpoint' } as never,
          content: [{ type: 'text', text: 'COMPACT CHECKPOINT: retain the checkpoint text.' }],
        },
        {
          id: 'task-relay' as never,
          role: 'user',
          source: { kind: 'task', form: 'relay' } as never,
          content: [{ type: 'text', text: 'TASK RELAY: keep the assigned constraint.' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'FINAL SHORT QUESTION: What is the next step?' }],
        },
      ] as GenerateOptions['messages'],
      tools: [{
        name: 'active-tool',
        description: 'An active declaration retained as data only.',
        parameters: { type: 'object', properties: {} },
      }],
    })
    const before = JSON.stringify(input)
    const serialized = serializeConversationRequest(input)
    expect(serialized.promptBytes).toBe(Buffer.byteLength(serialized.prompt, 'utf8'))
    expect(serialized.promptBytes).toBeLessThan(WEB_LLM_MAX_PROMPT_BYTES)
    expect(serialized.promptByteBreakdown.messages).toBeGreaterThan(0)
    expect(serialized.promptByteBreakdown.toolSchemas).toBeGreaterThan(0)
    expect(serialized.prompt).not.toContain('system-envelope-marker')
    expect(serialized.prompt).not.toContain('skill-catalog-marker')
    expect(serialized.prompt).not.toContain('RUNTIME CONTEXT MARKER')
    expect(serialized.prompt).not.toContain('TIME CONTEXT MARKER')
    expect(serialized.prompt).not.toContain('MEMORY CONTEXT MARKER')
    expect(serialized.prompt).not.toContain('HINDSIGHT RECALL MARKER')
    expect(serialized.prompt).not.toContain('MNEMON RECALL MARKER')
    expect(serialized.prompt).not.toContain('PLUGIN CATALOG MARKER')
    expect(serialized.prompt).not.toContain('GRAPH MEMORY SNAPSHOT MARKER')
    expect(serialized.prompt).not.toContain('DSH MNEMON TOOL INSTRUCTION: filter this native instruction.')
    expect(serialized.prompt).toContain('GRAPH MEMORY INSTRUCTIONS RETAIN MARKER')
    expect(serialized.prompt).toContain('UNKNOWN SYSTEM MESSAGE: retain this exact text.')
    expect(serialized.prompt).toContain('EXACT USER CONSTRAINT: answer in Chinese and preserve numbers.')
    expect(serialized.prompt).toContain('historical-tool')
    expect(serialized.prompt).toContain('HISTORICAL TOOL ERROR: unavailable result.')
    expect(serialized.prompt).toContain('"isError":true')
    expect(serialized.prompt).toContain('TASK NOTICE: retain the open task context.')
    expect(serialized.prompt).toContain('COMPACT CHECKPOINT: retain the checkpoint text.')
    expect(serialized.prompt).toContain('TASK RELAY: keep the assigned constraint.')
    expect(serialized.prompt).toContain('FINAL SHORT QUESTION: What is the next step?')
    expect(serialized.prompt).toContain('active-tool')
    expect(serialized.prompt.indexOf('EXACT USER CONSTRAINT: answer in Chinese and preserve numbers.')).toBeLessThan(
      serialized.prompt.indexOf('historical-tool'),
    )
    expect(serialized.prompt.indexOf('historical-tool')).toBeLessThan(
      serialized.prompt.indexOf('HISTORICAL TOOL ERROR: unavailable result.'),
    )
    expect(serialized.prompt.indexOf('HISTORICAL TOOL ERROR: unavailable result.')).toBeLessThan(
      serialized.prompt.indexOf('TASK NOTICE: retain the open task context.'),
    )
    expect(serialized.prompt.indexOf('TASK NOTICE: retain the open task context.')).toBeLessThan(
      serialized.prompt.indexOf('COMPACT CHECKPOINT: retain the checkpoint text.'),
    )
    expect(serialized.prompt.indexOf('COMPACT CHECKPOINT: retain the checkpoint text.')).toBeLessThan(
      serialized.prompt.indexOf('TASK RELAY: keep the assigned constraint.'),
    )
    expect(serialized.prompt.indexOf('TASK RELAY: keep the assigned constraint.')).toBeLessThan(
      serialized.prompt.indexOf('FINAL SHORT QUESTION: What is the next step?'),
    )
    expect(serialized.canonical).not.toContain('catalog-entry-marker')
    expect(serialized.canonical).not.toContain('instruction-entry-marker')
    expect(serialized.canonical).not.toContain('hindsight-recall-entry-marker')
    expect(serialized.canonical).not.toContain('mnemon-recall-entry-marker')
    expect(serialized.canonical).not.toContain('GRAPH MEMORY SNAPSHOT MARKER')
    expect(serialized.canonical).not.toContain('DSH MNEMON TOOL INSTRUCTION: filter this native instruction.')
    expect(serialized.canonical).toContain('GRAPH MEMORY INSTRUCTIONS RETAIN MARKER')
    expect(serialized.canonical).not.toContain('runtime-section-marker')
    expect(serialized.canonical).not.toContain('unknown-source-section-marker')
    expect(serialized.canonical).not.toContain('replay-state-marker')
    expect(JSON.stringify(input)).toBe(before)

    const controller = fakeController()
    const captures: WebRunRequest[] = []
    const adapter = new WebLlmAdapter(controller, {
      onRequest: async capture => { captures.push(capture.request) },
    })
    await collect(adapter.stream(input))
    expect(captures).toEqual([controller.start.mock.calls[0]?.[1]])
    expect(captures[0]?.prompt).toBe(serialized.prompt)
  })

  it('excludes only the automatic solar skill discovery notice from Web and Insight prompts', () => {
    const serialized = serializeConversationRequest(options({
      messages: [
        {
          id: 'solar-skill-notice' as never,
          role: 'user',
          source: { kind: 'solar-skill-context', form: 'notice', policyVersion: 1 } as never,
          content: [{ type: 'text', text: 'NATIVE SKILL NOTICE: use solar_skill_search.' }],
        },
        {
          id: 'solar-skill-instructions' as never,
          role: 'user',
          source: { kind: 'solar-skill-context', form: 'instructions', policyVersion: 1 } as never,
          content: [{ type: 'text', text: 'EXPLICIT SKILL INSTRUCTIONS: retain this text.' }],
        },
        {
          id: 'ordinary-notice' as never,
          role: 'user',
          source: { kind: 'task', form: 'notice' } as never,
          content: [{ type: 'text', text: 'USER TASK NOTICE: retain this text.' }],
        },
        {
          id: 'ordinary-user' as never,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'USER QUESTION: retain this text.' }],
        },
      ] as GenerateOptions['messages'],
    }))

    expect(serialized.prompt).not.toContain('NATIVE SKILL NOTICE: use solar_skill_search.')
    expect(serialized.prompt).toContain('EXPLICIT SKILL INSTRUCTIONS: retain this text.')
    expect(serialized.prompt).toContain('USER TASK NOTICE: retain this text.')
    expect(serialized.prompt).toContain('USER QUESTION: retain this text.')
  })

  it('drops exact solar Web/Grok request audit notices and keeps decisions, other content, and other sources', async () => {
    const actualUser = {
      id: 'audit-question' as never,
      role: 'user' as const,
      source: { kind: 'user' },
      content: [{ type: 'text' as const, text: 'AUDIT IDENTITY QUESTION: retain this user text.' }],
    }
    const webRequestAudit = {
      id: 'web-request-audit' as never,
      role: 'user' as const,
      source: { kind: 'solar-web-context', form: 'notice' },
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'web-request', commandId: 'audit-1' }) }],
    }
    const insightAnswers = {
      id: 'insight-answers-audit' as never,
      role: 'user' as const,
      source: { kind: 'solar-web-context', form: 'notice' },
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'insight-answers', answers: { choice: 'retain' } }) }],
    }
    const grokRequestAudit = {
      ...webRequestAudit,
      id: 'grok-request-audit' as never,
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'grok-request', id: 'grok-audit-1' }) }],
    }
    const planDecision = {
      id: 'plan-decision-audit' as never,
      role: 'user' as const,
      source: { kind: 'solar-web-context', form: 'notice' },
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'insight-plan-decision', confirmed: true }) }],
    }
    const multipleTextBlocks = {
      id: 'multiple-text-audit' as never,
      role: 'user' as const,
      source: { kind: 'solar-web-context', form: 'notice' },
      content: [
        { type: 'text' as const, text: JSON.stringify({ kind: 'web-request', commandId: 'audit-2' }) },
        { type: 'text' as const, text: 'EXPLICIT SECOND TEXT BLOCK' },
      ],
    }
    const malformedJson = {
      id: 'malformed-audit' as never,
      role: 'user' as const,
      source: { kind: 'solar-web-context', form: 'notice' },
      content: [{ type: 'text' as const, text: '{"kind":"web-request"' }],
    }
    const otherSource = {
      id: 'other-source-audit' as never,
      role: 'user' as const,
      source: { kind: 'task', form: 'notice' },
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'web-request', commandId: 'other-1' }) }],
    }
    const base = serializeConversationRequest(options({ messages: [actualUser] as GenerateOptions['messages'] }))
    const withAudit = serializeConversationRequest(options({
      messages: [actualUser, webRequestAudit, insightAnswers, planDecision, multipleTextBlocks, malformedJson, otherSource] as GenerateOptions['messages'],
    }))
    const withOnlyWebRequestAudit = serializeConversationRequest(options({
      messages: [actualUser, webRequestAudit, grokRequestAudit] as GenerateOptions['messages'],
    }))

    expect(withOnlyWebRequestAudit.id).toBe(base.id)
    expect(withOnlyWebRequestAudit.canonical).toBe(base.canonical)
    expect(withOnlyWebRequestAudit.prompt).toBe(base.prompt)
    expect(withAudit.prompt).not.toContain('audit-1')
    expect(withAudit.prompt).toContain('insight-answers')
    expect(withAudit.prompt).toContain('insight-plan-decision')
    expect(withAudit.prompt).toContain('EXPLICIT SECOND TEXT BLOCK')
    expect(withAudit.prompt).toContain('{"kind":"web-request"')
    expect(withAudit.prompt).toContain('other-1')
    expect(withAudit.canonical).not.toContain('audit-1')
    expect(withAudit.canonical).toContain('insight-answers')
    expect(withAudit.canonical).toContain('insight-plan-decision')
    expect(withAudit.canonical).toContain('other-1')

    const fake = fakeController()
    const adapter = new WebLlmAdapter(fake)
    await collect(adapter.stream(options({ messages: [actualUser] as GenerateOptions['messages'] })))
    await collect(adapter.stream(options({ messages: [actualUser, webRequestAudit] as GenerateOptions['messages'] })))
    expect(fake.start).toHaveBeenCalledOnce()
    expect(fake.observe).toHaveBeenCalledOnce()
    expect(fake.start.mock.calls[0]?.[0]).toBe(fake.observe.mock.calls[0]?.[0])
  })

  it('rejects images and files before controller admission', async () => {
    const fake = fakeController()
    const adapter = new WebLlmAdapter(fake)
    await expect(collect(adapter.stream(options({
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} as never }] } as never],
    })))).rejects.toMatchObject({ code: 'CHATGPT_WEB_IMAGE_UNSUPPORTED' })
    await expect(collect(adapter.stream(options({
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: {} as never }] } as never],
    })))).rejects.toMatchObject({ code: 'CHATGPT_WEB_FILE_UNSUPPORTED' })
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.observe).not.toHaveBeenCalled()
  })

  it('checks the complete prompt UTF-8 byte length before admission without truncating it', async () => {
    const source = fakeController()
    await collect(new WebLlmAdapter(source).stream(options({
      messages: [{
        id: 'unicode-user' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '😀'.repeat(64) }],
      }],
    })))
    const prompt = source.start.mock.calls[0]?.[1].prompt as string
    const bytes = Buffer.byteLength(prompt, 'utf8')
    const limited = fakeController()
    await expect(collect(new WebLlmAdapter(limited, { maxPromptBytes: bytes - 1 }).stream(options({
      messages: [{
        id: 'unicode-user' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '😀'.repeat(64) }],
      }],
    })))).rejects.toMatchObject({ code: 'WEB_PROMPT_TOO_LARGE' })
    expect(limited.start).not.toHaveBeenCalled()
  })

  it('rejects retained user, task, and one-shot system input before capture or browser admission with byte-only diagnostics', async () => {
    const cases: Array<readonly [string, GenerateOptions]> = [
      [
        'explicit user',
        options({
          messages: [{
            id: 'large-user' as never,
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: `large-user-marker:${'U'.repeat(WEB_LLM_MAX_PROMPT_BYTES)}` }],
          }],
        }),
      ],
      [
        'task notice',
        options({
          messages: [{
            id: 'large-task' as never,
            role: 'user',
            source: { kind: 'task', form: 'notice', summary: 'large task' } as never,
            content: [{ type: 'text', text: `large-task-marker:${'T'.repeat(WEB_LLM_MAX_PROMPT_BYTES)}` }],
          }],
        }),
      ],
      [
        'one-shot system',
        options({
          system: `large-system-marker:${'P'.repeat(WEB_LLM_MAX_PROMPT_BYTES)}`,
        }),
      ],
    ]

    for (const [name, input] of cases) {
      const before = JSON.stringify(input)
      const controller = fakeController()
      const capture = vi.fn(async () => undefined)
      const adapter = new WebLlmAdapter(controller, { onRequest: capture })
      const failure = await collect(adapter.stream(input)).then(
        () => undefined,
        error => error,
      )
      expect(failure, name).toMatchObject({ code: 'WEB_PROMPT_TOO_LARGE' })
      const message = (failure as Error).message
      expect(message).toMatch(/system=\d+, messages=\d+, toolSchemas=\d+, overhead=\d+/)
      expect(message).not.toContain('large-user-marker')
      expect(message).not.toContain('large-task-marker')
      expect(message).not.toContain('large-system-marker')
      expect(JSON.stringify(input)).toBe(before)
      expect(capture, name).not.toHaveBeenCalled()
      expect(controller.start, name).not.toHaveBeenCalled()
      expect(controller.observe, name).not.toHaveBeenCalled()
    }
  })

  it('uses a stable command id for the same durable request and a new id for a new message', async () => {
    const fake = fakeController()
    const adapter = new WebLlmAdapter(fake)
    const first = options()
    await collect(adapter.stream(first))
    await collect(adapter.stream(first))
    const second = options({
      messages: [{
        id: 'user-2' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请用 Markdown 回答。' }],
      }],
    })
    await collect(adapter.stream(second))
    expect(fake.start).toHaveBeenCalledTimes(2)
    expect(fake.observe).toHaveBeenCalledTimes(1)
    expect(fake.start.mock.calls[0]?.[0]).toBe(fake.observe.mock.calls[0]?.[0])
    expect(fake.start.mock.calls[0]?.[0]).not.toBe(fake.start.mock.calls[1]?.[0])
  })

  it('emits only a complete text block and stop for a completed record', async () => {
    const fake = fakeController({
      start: vi.fn(async (id, request) => record(id, request, 'completed', {
        output: { text: 'ignored plain text', markdown: '# 完整 Markdown\n\nanswer' },
      })),
    })
    const chunks = await collect(new WebLlmAdapter(fake).stream(options()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '# 完整 Markdown\n\nanswer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '# 完整 Markdown\n\nanswer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('turns an indeterminate result into a named error without resending on retry', async () => {
    const fake = fakeController({
      start: vi.fn(async (id, request) => record(id, request, 'indeterminate', {
        error: { code: 'WEB_SUBMISSION_MISMATCH', message: 'receipt unknown' },
      })),
      observe: vi.fn(async (id) => record(id, { prompt: 'observed' }, 'completed', {
        output: { text: '', markdown: 'reconciled answer' },
      })),
    })
    const adapter = new WebLlmAdapter(fake)
    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'WEB_RUN_INDETERMINATE' })
    await expect(collect(adapter.stream(options()))).resolves.toEqual(expect.arrayContaining([
      { type: 'text-delta', index: 0, text: 'reconciled answer' },
    ]))
    expect(fake.start).toHaveBeenCalledOnce()
    expect(fake.observe).toHaveBeenCalledOnce()
    expect(fake.start.mock.calls[0]?.[0]).toBe(fake.observe.mock.calls[0]?.[0])
  })

  it('forwards cancellation to the controller and rejects an aborted result', async () => {
    const caller = new AbortController()
    let forwarded: AbortSignal | undefined
    const fake = fakeController({
      start: vi.fn((id, request, signal) => new Promise<WebRunRecord>(resolve => {
        forwarded = signal
        if (signal?.aborted) {
          resolve(record(id, request, 'cancelled'))
          return
        }
        signal?.addEventListener('abort', () => resolve(record(id, request, 'cancelled')), { once: true })
      })),
    })
    const adapter = new WebLlmAdapter(fake)
    const pending = collect(adapter.stream(options({ signal: caller.signal })))
    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_RUN_ABORTED' })
    expect(forwarded).toBe(caller.signal)
  })

  it('rejects auxiliary purposes without touching the browser controller', async () => {
    const fake = fakeController()
    const adapter = new WebLlmAdapter(fake)
    await expect(collect(adapter.stream(options({ purpose: 'compaction' })))).rejects.toMatchObject({ code: 'WEB_PURPOSE_UNSUPPORTED' })
    await expect(collect(adapter.stream(options({ purpose: 'session-title' })))).rejects.toMatchObject({ code: 'WEB_PURPOSE_UNSUPPORTED' })
    await expect(collect(adapter.stream(options({ sessionId: undefined })))).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' })
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.observe).not.toHaveBeenCalled()
  })
})
