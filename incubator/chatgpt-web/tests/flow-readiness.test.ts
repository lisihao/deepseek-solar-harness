import { describe, expect, it } from 'vitest'

import { defaultWebPreferences } from '../src/preferences.js'
import { flowReadiness } from '../src/flow-readiness.js'
import { buildInsightStudioGraph } from '../src/studio-provider.js'
import type { JsonObject } from '../../native-collaboration/src/studio-contract.js'

function graph(geminiSemantics?: JsonObject) {
  const preferences = defaultWebPreferences()
  const built = buildInsightStudioGraph({
    sessionId: 'readiness-session',
    context: 'context',
    question: 'question',
    config: preferences.insight,
  })
  return {
    ...built,
    parameters: {
      ...built.parameters,
      ...(geminiSemantics === undefined ? {} : { geminiSemantics }),
    } satisfies JsonObject,
  }
}

describe('flowReadiness', () => {
  it('uses the same full-flow readiness as the Insight model entry before any executor exists', () => {
    const issues = flowReadiness(graph())

    expect(issues).toEqual([])
  })

  it('keeps an explicitly supplied research-start locator in the same ready graph contract', () => {
    expect(flowReadiness(graph({
      researchStartSelector: '[data-fixture-visible-start]',
    }))).toEqual([])
  })
})
