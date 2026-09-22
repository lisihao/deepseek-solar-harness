/** Deterministic adapter that rejects a Loader request missing the seeded task template. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FIXTURE_TEMPLATE_ID } from './seed.ts'

class TemplateCheckingAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (!text.includes(FIXTURE_TEMPLATE_ID)) {
      throw new Error('task-template Loader fixture request omitted the selected template')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'fixture playbook complete' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'task-template-mock-llm'
export const inject = ['llm']

/**
 * Register the fixture adapter for the Loader-owned AgentLoop.
 * @param ctx - Loader context carrying the LLM registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new TemplateCheckingAdapter()))
}
