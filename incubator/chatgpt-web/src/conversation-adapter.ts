import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { StudioRun } from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import {
  latestUserTextFromMessages,
  projectBrowserPortableRequest,
  serializeConversationRequest,
  WEB_LLM_MODEL,
  WEB_LLM_NAME,
  WEB_LLM_PROVIDER,
  type WebLlmAdapter,
} from './llm-adapter.js'

export const INSIGHT_LLM_MODEL = 'insight-analysis' as const
export const INSIGHT_LLM_NAME = '洞察分析' as const

export interface InsightStartInput {
  readonly id: string
  readonly sessionId: string
  readonly question: string
  readonly conversationContext: string
  readonly signal?: AbortSignal
}

export interface ConversationWebAdapterOptions {
  readonly web: WebLlmAdapter
  readonly startInsight: (input: InsightStartInput) => Promise<StudioRun>
  readonly inspectInsight: (sessionId: string, id: string) => Promise<StudioRun>
  readonly resolveDelivery?: (sessionId: string, text: string) => Promise<string | undefined>
  readonly insightWaitMs: number
  readonly pollMs: number
}

type InsightEntry = {
  readonly canonical: string
  inFlight?: Promise<StudioRun>
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw new LlmError('ChatGPT Web 请求已取消；未自动重试。', 'WEB_RUN_ABORTED')
}

function terminalInsight(run: StudioRun): boolean {
  return run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'unknown'
}

function completedInsightText(run: StudioRun): string {
  if (run.status === 'completed' && typeof run.output === 'string') return run.output
  if (run.status === 'unknown') {
    throw new LlmError(`洞察分析结果未确定${run.message === undefined ? '' : `：${run.message}`}；未自动重试。`, 'WEB_INSIGHT_UNKNOWN')
  }
  if (run.status === 'failed') {
    throw new LlmError(`洞察分析执行失败${run.message === undefined ? '' : `：${run.message}`}；未自动重试。`, 'WEB_INSIGHT_FAILED')
  }
  if (run.status === 'cancelled') {
    throw new LlmError('洞察分析已取消；仅停止本机等待，未宣称远端任务已停止。', 'WEB_INSIGHT_ABORTED')
  }
  if (run.status === 'completed') {
    throw new LlmError('洞察分析已完成但没有完整 Markdown 输出。', 'WEB_INSIGHT_OUTPUT_MISSING')
  }
  throw new LlmError(`洞察分析尚未完成（${run.status}）。`, 'WEB_INSIGHT_INCOMPLETE')
}

async function* textChunks(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  if (text.length > 0) yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new LlmError('洞察分析本机等待已取消；未宣称远端任务已停止。', 'WEB_INSIGHT_ABORTED'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function wrapInsightError(error: unknown, code: string, message: string): LlmError {
  if (error instanceof LlmError) return error
  return new LlmError(message, code, { cause: error })
}

/**
 * Public provider that composes ordinary Web conversation requests with the
 * bounded, durable Insight Studio route. It owns no browser or Studio store;
 * both effects arrive through the injected public contracts.
 */
export class ConversationWebAdapter extends LlmAdapter {
  private readonly options: ConversationWebAdapterOptions
  private readonly insightRuns = new Map<string, InsightEntry>()

  constructor(options: ConversationWebAdapterOptions) {
    super()
    if (!options || typeof options !== 'object' || options.web === undefined) {
      throw new LlmError('ChatGPT Web 会话适配器缺少普通网页适配器。', 'CHATGPT_WEB_ADAPTER_INVALID')
    }
    if (typeof options.startInsight !== 'function' || typeof options.inspectInsight !== 'function') {
      throw new LlmError('ChatGPT Web 会话适配器缺少洞察分析控制接口。', 'CHATGPT_WEB_ADAPTER_INVALID')
    }
    if (!Number.isSafeInteger(options.insightWaitMs) || options.insightWaitMs < 0
      || !Number.isSafeInteger(options.pollMs) || options.pollMs <= 0) {
      throw new LlmError('洞察分析等待参数无效。', 'CHATGPT_WEB_CONFIG_INVALID')
    }
    this.options = options
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== WEB_LLM_PROVIDER) {
      throw new LlmError(`ChatGPT Web 不支持 provider ${provider}。`, 'CHATGPT_WEB_PROVIDER_INVALID')
    }
    return { id: WEB_LLM_PROVIDER, name: WEB_LLM_NAME }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.providerInfo(provider)
    return this.options.web.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    return [
      { provider: WEB_LLM_PROVIDER, id: WEB_LLM_MODEL, name: WEB_LLM_NAME },
      { provider: WEB_LLM_PROVIDER, id: INSIGHT_LLM_MODEL, name: INSIGHT_LLM_NAME },
    ]
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    throwIfAborted(signal)
    if (model === WEB_LLM_MODEL) return this.options.web.resolveModel(provider, model, signal)
    if (model === INSIGHT_LLM_MODEL) return { provider: WEB_LLM_PROVIDER, id: INSIGHT_LLM_MODEL, name: INSIGHT_LLM_NAME }
    throw new LlmError(`ChatGPT Web 不支持模型 ${model}。`, 'CHATGPT_WEB_MODEL_INVALID')
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== WEB_LLM_PROVIDER) {
      throw new LlmError(`ChatGPT Web 不支持 provider ${options.provider}。`, 'CHATGPT_WEB_PROVIDER_INVALID')
    }
    if (options.model !== WEB_LLM_MODEL && options.model !== INSIGHT_LLM_MODEL) {
      throw new LlmError(`ChatGPT Web 不支持模型 ${options.model}。`, 'CHATGPT_WEB_MODEL_INVALID')
    }
    if (options.sessionId === undefined || String(options.sessionId).length === 0) {
      throw new LlmError('ChatGPT Web 主模型请求必须带有 durable sessionId。', 'WEB_SESSION_REQUIRED')
    }
    if (options.purpose !== undefined) {
      throw new LlmError('ChatGPT Web 会话适配器不接受 compaction 或 session-title 请求。', 'WEB_PURPOSE_UNSUPPORTED')
    }
    if (!Array.isArray(options.messages)) {
      throw new LlmError('ChatGPT Web 请求缺少有序 messages。', 'CHATGPT_WEB_INVALID_REQUEST')
    }
    throwIfAborted(options.signal)

    // This extracts and validates the latest portable user text before either
    // route or the delivery resolver can cause an external effect. The Web
    // operator cannot use Harness-only prompt/catalog snapshots as a question.
    const portableOptions = projectBrowserPortableRequest(options)
    const question = latestUserTextFromMessages(portableOptions.messages)
    const sessionId = String(options.sessionId)
    const serialized = serializeConversationRequest(portableOptions, {
      ...(portableOptions.reasoningEffort === undefined ? {} : { effortLabel: String(portableOptions.reasoningEffort) }),
    })
    if (this.options.resolveDelivery !== undefined) {
      let delivered: string | undefined
      try {
        delivered = await this.options.resolveDelivery(sessionId, question)
      } catch (error) {
        if (options.signal?.aborted) throw new LlmError('ChatGPT Web 请求已取消；未自动重试。', 'WEB_RUN_ABORTED', { cause: error })
        throw wrapInsightError(error, 'WEB_DELIVERY_RESOLUTION_FAILED', '已完成流程结果解析失败；未重新执行网页或洞察请求。')
      }
      throwIfAborted(options.signal)
      if (delivered !== undefined) {
        if (typeof delivered !== 'string') {
          throw new LlmError('已完成流程结果不是文本；未重新执行网页或洞察请求。', 'WEB_DELIVERY_INVALID')
        }
        yield* textChunks(delivered)
        return
      }
    }

    if (options.model === WEB_LLM_MODEL) {
      yield* this.options.web.stream(portableOptions)
      return
    }
    if (options.model !== INSIGHT_LLM_MODEL) {
      throw new LlmError(`ChatGPT Web 不支持模型 ${options.model}。`, 'CHATGPT_WEB_MODEL_INVALID')
    }

    const run = await this.insight(serialized.id, serialized.canonical, serialized.sessionId, question, serialized.prompt, options.signal)
    throwIfAborted(options.signal)
    yield* textChunks(completedInsightText(run))
  }

  private insight(
    id: string,
    canonical: string,
    sessionId: string,
    question: string,
    conversationContext: string,
    signal: AbortSignal | undefined,
  ): Promise<StudioRun> {
    const existing = this.insightRuns.get(id)
    if (existing !== undefined) {
      if (existing.canonical !== canonical) return Promise.reject(new LlmError('洞察分析 durable command identity 冲突。', 'WEB_INSIGHT_COMMAND_CONFLICT'))
      if (existing.inFlight !== undefined) return existing.inFlight
      return this.inspect(sessionId, id, signal)
    }
    const entry: InsightEntry = { canonical }
    this.insightRuns.set(id, entry)
    const promise = this.startAndPoll({ id, sessionId, question, conversationContext, signal })
    entry.inFlight = promise
    void promise.then(
      () => { if (entry.inFlight === promise) delete entry.inFlight },
      () => { if (entry.inFlight === promise) delete entry.inFlight },
    )
    return promise
  }

  private async startAndPoll(input: InsightStartInput): Promise<StudioRun> {
    throwIfAborted(input.signal)
    let current: StudioRun
    try {
      current = await this.options.startInsight(input)
    } catch (error) {
      if (input.signal?.aborted) throw new LlmError('洞察分析本机等待已取消；未宣称远端任务已停止。', 'WEB_INSIGHT_ABORTED', { cause: error })
      throw wrapInsightError(error, 'WEB_INSIGHT_START_FAILED', '洞察分析启动失败；未自动重试。')
    }
    if (terminalInsight(current)) return current

    const deadline = Date.now() + this.options.insightWaitMs
    for (;;) {
      throwIfAborted(input.signal)
      if (Date.now() > deadline) throw new LlmError('洞察分析等待超时；原任务未重新提交。', 'WEB_INSIGHT_TIMEOUT')
      try {
        current = await this.options.inspectInsight(input.sessionId, input.id)
      } catch (error) {
        if (input.signal?.aborted) throw new LlmError('洞察分析本机等待已取消；未宣称远端任务已停止。', 'WEB_INSIGHT_ABORTED', { cause: error })
        throw wrapInsightError(error, 'WEB_INSIGHT_INSPECT_FAILED', '洞察分析状态读取失败；未自动重试。')
      }
      if (terminalInsight(current)) return current
      throwIfAborted(input.signal)
      const remaining = Math.max(0, deadline - Date.now())
      if (remaining === 0) throw new LlmError('洞察分析等待超时；原任务未重新提交。', 'WEB_INSIGHT_TIMEOUT')
      await waitFor(Math.min(this.options.pollMs, remaining), input.signal)
    }
  }

  private inspect(sessionId: string, id: string, signal: AbortSignal | undefined): Promise<StudioRun> {
    return Promise.resolve()
      .then(() => this.options.inspectInsight(sessionId, id))
      .catch(error => {
        if (signal?.aborted) throw new LlmError('洞察分析本机等待已取消；未宣称远端任务已停止。', 'WEB_INSIGHT_ABORTED', { cause: error })
        throw wrapInsightError(error, 'WEB_INSIGHT_INSPECT_FAILED', '洞察分析状态读取失败；未自动重试。')
      })
  }
}
