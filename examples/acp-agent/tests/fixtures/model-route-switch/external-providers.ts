/** Deterministic external boundaries for the real model-route-switch composition. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorExecutionMode,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
} from '@deepseek-ai/dsh-physical-operator'

/** Observable calls made across the two mocked external provider boundaries. */
export const calls = {
  claudeQualifications: 0,
  claudeStarts: 0,
  chatgptBrowserPrograms: 0,
}

/** Reset process-local fixture evidence before each Loader composition mounts. */
export function resetCalls(): void {
  calls.claudeQualifications = 0
  calls.claudeStarts = 0
  calls.chatgptBrowserPrograms = 0
}

/** Claude must never enter admission after the user selects ChatGPT Web. */
class ClaudeTrapOperator implements PhysicalOperator {
  readonly descriptor = {
    id: PhysicalOperatorId('claude-code'),
    displayName: 'Claude Code',
    description: 'External Claude fixture that must remain unused.',
    tags: ['claude', 'subscription'],
    maxConcurrency: 1,
    executionModes: ['ephemeral', 'resident'] as const,
  }

  availability(mode?: PhysicalOperatorExecutionMode) {
    // Discovery may inspect every provider, but an admission qualification is
    // always mode-specific. Counting that edge proves Claude did not receive
    // the selected ChatGPT request.
    if (mode !== undefined) calls.claudeQualifications += 1
    return { available: true as const }
  }

  async start(_request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    calls.claudeStarts += 1
    throw new Error('Claude must not start after ChatGPT Web is selected')
  }
}

const browser: BrowserProvider = {
  descriptor: {
    id: BrowserProviderId('model-route-switch-browser'),
    layers: ['browser-js-v1'],
    capabilities: ['authenticated-profile-reuse', 'named-workspace', 'page-evaluate'],
  },
  available: () => true,
  async runProgram(program: BrowserRunProgramV1): Promise<BrowserRunProgramResultV1> {
    calls.chatgptBrowserPrograms += 1
    if (!program.source.includes('你是那个模型')) {
      throw new Error('ChatGPT Web provider did not receive the exact user prompt')
    }
    return {
      version: 1,
      workspace: {
        id: BrowserWorkspaceId('model-route-switch'),
        lifecycle: 'active',
        control: 'agent',
      },
      output: {
        kind: 'json',
        value: { status: 'completed', response: '我是 ChatGPT Web', truncated: false },
      },
    }
  },
}

export const name = 'model-route-switch-external-providers'
export const inject = ['browser', 'physicalOperators']

/** Register only the external browser and Claude subscription boundaries. */
export function apply(ctx: Context): void {
  resetCalls()
  ctx.browser.registerProvider(browser)
  ctx.physicalOperators.registerOperator(new ClaudeTrapOperator())
}
