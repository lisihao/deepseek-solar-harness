import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { assertSupportedJsonSchema, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createWebProvider, createWebTool } from '../src/bindings.js'
import type { WebRunRecord, WebRunRequest } from '../src/store.js'

const commandId = '11111111-1111-4111-8111-111111111111'

function record(
  request: WebRunRequest,
  stage: WebRunRecord['stage'] = 'completed',
  overrides: Partial<WebRunRecord> = {},
): WebRunRecord {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return {
    formatVersion: 1,
    id: commandId,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    request,
    stage,
    ...overrides,
  }
}

function controller(overrides: Partial<{
  start: (id: string, request: WebRunRequest, signal?: AbortSignal) => Promise<WebRunRecord>
  read: (id: string) => Promise<WebRunRecord | undefined>
  list: () => Promise<readonly WebRunRecord[]>
  observe: (id: string, signal?: AbortSignal) => Promise<WebRunRecord>
  cancel: (id: string) => Promise<WebRunRecord>
  dispose: () => Promise<void>
}> = {}) {
  const value = {
    start: vi.fn(async (id: string, request: WebRunRequest) => record(request, 'completed', {
      id,
      output: { text: '# ignored text field', markdown: '# full markdown output' },
    })),
    read: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as readonly WebRunRecord[]),
    observe: vi.fn(async (id: string) => record({ prompt: 'observed' }, 'completed', {
      id,
      output: { text: 'ignored', markdown: 'observed markdown' },
    })),
    cancel: vi.fn(async (id: string) => record({ prompt: 'cancelled' }, 'cancelled', { id })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  }
  return value
}

function providerRequest(signal: AbortSignal, prompt: readonly ContentBlock[]): Parameters<NonNullable<ReturnType<typeof createWebProvider>['start']>>[0] {
  return {
    cwd: '/private/secret-files',
    parent: { secret: 'do-not-read' },
    prompt,
    signal,
  } as never
}

function toolExec(signal = new AbortController().signal): never {
  return {
    callId: 'tool-call',
    rootCallId: 'tool-root',
    name: 'solar_chatgpt_web',
    arguments: {},
    signal,
    token: Symbol(),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as never
}

describe('ChatGPT Web public bindings', () => {
  it('publishes schemas accepted by the rc.2 tool boundary', () => {
    const tool = createWebTool(controller())
    expect(() => assertSupportedJsonSchema(tool.output.schema)).not.toThrow()
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { action: { enum: ['run', 'inspect', 'observe', 'cancel', 'list'] } },
    })
    const ctx = new Context()
    const removePrompt = ctx.provide('systemPrompt', {
      tools: () => () => undefined,
      section: () => () => undefined,
      getSectionOrder: () => 0,
    })
    const runtime = new ToolRuntime(ctx)
    const unregister = runtime.register(tool)
    expect(runtime.get('solar_chatgpt_web')).toBe(tool)
    unregister()
    expect(runtime.get('solar_chatgpt_web')).toBeUndefined()
    removePrompt()
  })

  it('accepts only text blocks and converts completed full markdown to text', async () => {
    const calls: Array<{ id: string; request: WebRunRequest; signal?: AbortSignal }> = []
    const fake = controller({
      start: vi.fn(async (id, request, signal) => {
        calls.push({ id, request, signal })
        return record(request, 'completed', {
          id,
          output: { text: 'do not use', markdown: '# FULL\n\nall of it' },
        })
      }),
    })
    const provider = createWebProvider(fake, { modelLabel: 'Default Model', effortLabel: 'Default Effort' })
    const run = await provider.start!(providerRequest(new AbortController().signal, [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]))
    const result = await run.result

    expect(run.id).toMatch(UUID_PATTERN)
    expect(calls[0]?.request).toEqual({ prompt: 'hello world', modelLabel: 'Default Model', effortLabel: 'Default Effort' })
    expect(result).toEqual({ stopReason: 'completed', output: [{ type: 'text', text: '# FULL\n\nall of it' }] })
    await expect(provider.start!(providerRequest(new AbortController().signal, [
      { type: 'image', attachment: {} },
    ] as never))).rejects.toThrow('只接受文本输入')
    await expect(provider.start!(providerRequest(new AbortController().signal, [{ type: 'text', text: '' }]))).rejects.toThrow('不能为空')
    await expect(provider.start!(providerRequest(new AbortController().signal, [{ type: 'text', text: 'x'.repeat(128 * 1024 + 1) }]))).rejects.toThrow('128 KiB')
    expect(fake.start).toHaveBeenCalledOnce()
  })

  it('advertises no inherited or optional capabilities and disposal is local, idempotent, and observable as aborted', async () => {
    let resolveStart!: (value: WebRunRecord) => void
    let resolveCancel!: () => void
    const fake = controller({
      start: vi.fn((id, request, signal) => new Promise<WebRunRecord>((resolve) => {
        resolveStart = resolve
        signal?.addEventListener('abort', () => resolve(record(request, 'cancelled', { id })), { once: true })
      })),
      cancel: vi.fn(async (id) => new Promise<WebRunRecord>((resolve) => {
        resolveCancel = () => resolve(record({ prompt: 'cancelled' }, 'cancelled', { id }))
        resolveStart(record({ prompt: 'cancelled' }, 'cancelled', { id }))
      })),
    })
    const provider = createWebProvider(fake)
    expect(provider).toMatchObject({
      name: 'chatgpt-web',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
    })
    const run = await provider.start!(providerRequest(new AbortController().signal, [{ type: 'text', text: 'secret prompt' }]))
    const first = run.dispose()
    const second = run.dispose()
    let disposalSettled = false
    void first.then(() => { disposalSettled = true })
    await Promise.resolve()
    expect(disposalSettled).toBe(false)
    resolveCancel()
    await Promise.all([first, second])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(fake.cancel).toHaveBeenCalledOnce()
    expect(resolveStart).toBeTypeOf('function')
  })

  it('links caller cancellation and removes the listener after a settled run', async () => {
    const caller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const fake = controller({
      start: vi.fn(async (id, request, signal) => {
        observedSignal = signal
        return record(request, 'completed', { id, output: { text: '', markdown: 'done' } })
      }),
    })
    const provider = createWebProvider(fake)
    const run = await provider.start!(providerRequest(caller.signal, [{ type: 'text', text: 'hello' }]))
    await run.result
    caller.abort()
    expect(observedSignal?.aborted).toBe(false)
    expect(fake.cancel).not.toHaveBeenCalled()
  })

  it('does not turn failed or indeterminate records into success and keeps diagnostics request-safe', async () => {
    let starts = 0
    const fake = controller({
      start: vi.fn(async (id, request) => {
        starts += 1
        return starts === 1
          ? record(request, 'failed', {
            id,
            error: { code: 'WEB_MODEL_MISMATCH', message: 'visible detail must stay out of provider diagnostic' },
          })
          : record(request, 'indeterminate', { id })
      }),
    })
    const provider = createWebProvider(fake)
    const run = await provider.start!(providerRequest(new AbortController().signal, [{ type: 'text', text: 'raw secret prompt' }]))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('WEB_MODEL_MISMATCH')
    expect(result.diagnostic).not.toContain('raw secret prompt')

    const indeterminate = await provider.start!(providerRequest(new AbortController().signal, [{ type: 'text', text: 'indeterminate prompt' }]))
    await expect(indeterminate.result).resolves.toMatchObject({ stopReason: 'error' })
  })

  it('strictly validates action-specific input before any controller call', async () => {
    const fake = controller()
    const tool = createWebTool(fake, { modelLabel: 'Default Model', effortLabel: 'Default Effort' })
    await expect(tool.execute({ action: 'run', command_id: commandId, prompt: 'x', extra: true }, toolExec())).rejects.toThrow('未支持字段')
    await expect(tool.execute({ action: 'inspect', command_id: commandId, prompt: 'must reject' }, toolExec())).rejects.toThrow('不接受 prompt')
    await expect(tool.execute({ action: 'run', command_id: 'not-a-uuid', prompt: 'x' }, toolExec())).rejects.toThrow('必须是 UUID')
    await expect(tool.execute({ action: 'list', model_label: 'must reject' }, toolExec())).rejects.toThrow('list 不接受')
    await expect(tool.execute({ action: 'run', command_id: commandId, prompt: '' }, toolExec())).rejects.toThrow('不能为空')
    await expect(tool.execute({ action: 'run', command_id: commandId, prompt: 'x'.repeat(128 * 1024 + 1) }, toolExec())).rejects.toThrow('128 KiB')
    expect(fake.start).not.toHaveBeenCalled()
  })

  it('uses explicit run choices, applies defaults only when omitted, and keeps read-only actions browser-free', async () => {
    const startRequests: WebRunRequest[] = []
    const fake = controller({
      start: vi.fn(async (id, request) => {
        startRequests.push(request)
        return record(request, 'completed', { id, output: { text: '', markdown: 'run' } })
      }),
      read: vi.fn(async id => record({ prompt: 'read' }, 'completed', { id, output: { text: '', markdown: 'read' } })),
      list: vi.fn(async () => [record({ prompt: 'list' })]),
      observe: vi.fn(async id => record({ prompt: 'observe' }, 'completed', { id, output: { text: '', markdown: 'observe' } })),
      cancel: vi.fn(async id => record({ prompt: 'cancel' }, 'cancelled', { id })),
    })
    const tool = createWebTool(fake, { modelLabel: 'Default Model', effortLabel: 'Default Effort' })
    const explicit = await tool.execute({ action: 'run', command_id: commandId, prompt: 'explicit', model_label: 'Chosen', effort_label: 'High' }, toolExec())
    expect(explicit).toMatchObject({ action: 'run', record: { request: { modelLabel: 'Chosen', effortLabel: 'High' } } })
    await tool.execute({ action: 'run', command_id: '22222222-2222-4222-8222-222222222222', prompt: 'defaults' }, toolExec())
    expect(startRequests[1]).toEqual({ prompt: 'defaults', modelLabel: 'Default Model', effortLabel: 'Default Effort' })

    await tool.execute({ action: 'inspect', command_id: commandId }, toolExec())
    await tool.execute({ action: 'observe', command_id: commandId }, toolExec())
    await tool.execute({ action: 'cancel', command_id: commandId }, toolExec())
    await tool.execute({ action: 'list' }, toolExec())
    expect(fake.start).toHaveBeenCalledTimes(2)
    expect(fake.read).toHaveBeenCalledOnce()
    expect(fake.observe).toHaveBeenCalledOnce()
    expect(fake.cancel).toHaveBeenCalledOnce()
    expect(fake.list).toHaveBeenCalledOnce()
  })

  it('renders complete records with requested and observed selection and named errors without clipping', () => {
    const fake = controller()
    const tool = createWebTool(fake)
    const markdown = '# full output\n\n' + 'x'.repeat(5000)
    const value = {
      action: 'inspect',
      commandId,
      record: record({ prompt: 'entire prompt', modelLabel: 'Requested', effortLabel: 'Requested Effort' }, 'failed', {
        observed: { modelLabel: 'Actual', effortLabel: 'Actual Effort' },
        output: { text: 'ignored', markdown },
        error: { code: 'WEB_SUBMISSION_UNKNOWN', message: '命名错误' },
      }),
    }
    const rendered = tool.output.render({}, value as never)[0]
    expect(rendered).toMatchObject({ type: 'text' })
    const text = (rendered as { type: 'text'; text: string }).text
    expect(text).toContain(commandId)
    expect(text).toContain('请求模型：Requested')
    expect(text).toContain('实际模型：Actual')
    expect(text).toContain(markdown)
    expect(text).toContain('WEB_SUBMISSION_UNKNOWN：命名错误')
  })
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
