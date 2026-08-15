/** Deterministic Loader fixture for the physical-operator-to-subagent route. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'

class NeverCalledAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('physical-operator Loader fixture must not start a model turn')
  }
}

class ScriptedProvider implements SubagentProvider {
  readonly name = 'scripted-physics'
  readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const text = request.prompt
      .filter((block): block is Extract<(typeof request.prompt)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    return {
      id: SessionId('scripted:loader-child'),
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: `fixture computed: ${text}` }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    }
  }
}

export const name = 'physical-operator-loader-fixture'
export const inject = ['llm', 'subagents']

/** Register deterministic LLM and subagent boundaries for a keyless Loader proof. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['fixture'], new NeverCalledAdapter())
  ctx.subagents.registerProvider(new ScriptedProvider())
}
