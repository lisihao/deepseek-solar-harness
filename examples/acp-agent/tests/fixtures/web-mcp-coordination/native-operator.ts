/** Deterministic external native operator reached through the real physical_operator tool. */

import type { Context } from '@deepseek-ai/cordis'
import { receiveOperatorContextEnvelope } from '@deepseek-ai/dsh-system-prompt'
import {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
} from '@deepseek-ai/dsh-physical-operator'

/** Stable fixture operator id exposed through the real physical-operator registry. */
export const NATIVE_OPERATOR_ID = 'fixture-native-codex'
/** Bounded result emitted by the fake external native product. */
export const NATIVE_OPERATOR_REPLY = 'Native Codex fixture completed.'

/** External product double: DSH owns routing, context, tool authorization, and durable receipts. */
class FixtureNativeCodexOperator implements PhysicalOperator {
  readonly descriptor = {
    id: PhysicalOperatorId(NATIVE_OPERATOR_ID),
    displayName: 'Fixture Native Codex',
    description: 'Executes one bounded native fixture task.',
    tags: ['fixture', 'native', 'coding'],
    maxConcurrency: 1,
    executionModes: ['ephemeral'] as const,
  }

  availability() {
    return { available: true as const }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (request.mode !== 'ephemeral') throw new Error('fixture native Codex accepts only ephemeral work')
    const prompt = request.prompt.filter(block => block.type === 'text').map(block => block.text).join('')
    if (prompt !== 'Return the fixture-native result.') throw new Error('fixture native Codex received an unexpected task')
    return {
      ...request.contextEnvelope === undefined ? {} : {
        contextReceipt: receiveOperatorContextEnvelope(request.contextEnvelope, NATIVE_OPERATOR_ID, 'native'),
      },
      result: Promise.resolve({
        output: [{ type: 'text', text: NATIVE_OPERATOR_REPLY }],
        stopReason: 'completed',
      }),
      dispose: () => Promise.resolve(),
    }
  }
}

export const name = 'web-mcp-coordination-native-operator'
export const inject = ['physicalOperators']

/** Register only the fake external native product for the assembled scenario. */
export function apply(ctx: Context): void {
  ctx.physicalOperators.registerOperator(new FixtureNativeCodexOperator())
}
