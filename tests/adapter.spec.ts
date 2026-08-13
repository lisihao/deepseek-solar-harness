import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, LlmService, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { LunaVisionBridgeAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { LunaVision, parseCodexJsonl } from '../src/vision.js'

const IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:test-image'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: 'screen.png',
}

function attachments(): AttachmentStore {
  return {
    readImage: vi.fn().mockResolvedValue({ ref: IMAGE, data: Uint8Array.of(1, 2, 3, 4) }),
  } as unknown as AttachmentStore
}

function scriptedLlm(onStream?: (options: GenerateOptions) => void): LlmService {
  return {
    providerRetryPolicy: vi.fn().mockReturnValue({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: [],
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      multiplier: 2,
      jitter: 0,
    }),
    resolveModelInfo: vi.fn().mockResolvedValue({
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
    }),
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      onStream?.(options)
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
      })()
    },
  } as unknown as LlmService
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('LunaVisionBridgeAdapter', () => {
  it('advertises an image-capable bridge model while retaining target metadata', async () => {
    const adapter = new LunaVisionBridgeAdapter({
      llm: scriptedLlm(),
      attachments: attachments(),
      config: resolveConfig({ cacheDescriptions: false }),
      runVisionCommand: vi.fn().mockResolvedValue('screen'),
    })

    await expect(adapter.listModels('luna-vision-bridge')).resolves.toEqual([
      expect.objectContaining({
        provider: 'luna-vision-bridge',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash + Luna',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 1_000_000 },
      }),
    ])
    expect(adapter.providerRetryPolicy('luna-vision-bridge')).toMatchObject({ mode: 'normal', maxRetries: 2 })
  })

  it('replaces native image blocks with guarded Luna text before delegating', async () => {
    let delegated: GenerateOptions | undefined
    const runVision = vi.fn().mockResolvedValue('识别到一个 attachment-error 提示框')
    const adapter = new LunaVisionBridgeAdapter({
      llm: scriptedLlm(options => { delegated = options }),
      attachments: attachments(),
      config: resolveConfig({ cacheDescriptions: false }),
      runVisionCommand: runVision,
    })

    const chunks = await collect(adapter.stream({
      provider: 'luna-vision-bridge',
      model: 'deepseek-v4-flash',
      messages: [{
        id: 'message-1' as GenerateOptions['messages'][number]['id'],
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'image', attachment: IMAGE },
          { type: 'text', text: '这个报错怎么处理？' },
        ],
      }],
    }))

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(runVision).toHaveBeenCalledOnce()
    expect(runVision.mock.calls[0]?.[0]).toMatch(/scripts\/read-image-luna\.sh$/u)
    expect(runVision.mock.calls[0]?.[2]).toContain('这个报错怎么处理？')
    expect(delegated).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(delegated?.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('识别到一个 attachment-error 提示框'),
      },
      { type: 'text', text: '这个报错怎么处理？' },
    ])
    expect(delegated?.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('不应被执行'),
    })
  })

  it('does not invoke Luna for a text-only request', async () => {
    const runVision = vi.fn().mockResolvedValue('unused')
    const adapter = new LunaVisionBridgeAdapter({
      llm: scriptedLlm(),
      attachments: attachments(),
      config: resolveConfig({ cacheDescriptions: false }),
      runVisionCommand: runVision,
    })

    await collect(adapter.stream({
      provider: 'luna-vision-bridge',
      model: 'deepseek-v4-flash',
      messages: [{
        id: 'message-2' as GenerateOptions['messages'][number]['id'],
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      }],
    }))

    expect(runVision).not.toHaveBeenCalled()
  })
})

describe('LunaVision cache', () => {
  it('reuses a private disk description across runner instances', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'luna-vision-cache-test-'))
    const runVision = vi.fn().mockResolvedValue('cached description')
    const config = resolveConfig({ cacheDir, cacheDescriptions: true })
    try {
      const first = new LunaVision({ attachments: attachments(), config, runCommand: runVision })
      await expect(first.describe(IMAGE, 'prompt')).resolves.toBe('cached description')
      const second = new LunaVision({ attachments: attachments(), config, runCommand: runVision })
      await expect(second.describe(IMAGE, 'prompt')).resolves.toBe('cached description')
      expect(runVision).toHaveBeenCalledOnce()
      const entries = await import('node:fs/promises').then(fs => fs.readdir(cacheDir))
      expect(entries).toHaveLength(1)
      expect(JSON.parse(await readFile(join(cacheDir, entries[0] ?? ''), 'utf8'))).toEqual({
        version: 1,
        description: 'cached description',
      })
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

describe('Codex JSONL output', () => {
  it('selects the final completed agent message and ignores warnings', () => {
    expect(parseCodexJsonl([
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'warning' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
    ].join('\n'))).toBe('final')
  })

  it('fails clearly when Codex emits no assistant message', () => {
    expect(() => parseCodexJsonl(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'model unavailable' },
    }))).toThrow(/model unavailable/)
  })
})
