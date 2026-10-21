import { describe } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loadDeclarativeSuite } from '@deepseek-ai/dsh-bench'
import { describeSuiteConformance } from '@deepseek-ai/dsh-bench-testkit'
import { SUITE_DIR } from '@deepseek-ai/dsh-bench-suite-dsh-native'

const bashCall = { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } } as SessionEvent

const suite = await loadDeclarativeSuite(SUITE_DIR)

describe('dsh-native suite', () => {
  describeSuiteConformance({
    suite,
    runs: {
      'fix-sum-bug': {
        pass: { files: { 'sum.js': 'export function sum(values) {\n  let total = 0\n  for (const value of values) total += value\n  return total\n}\n' } },
        fail: {},
      },
      'count-lines': { pass: { files: { 'answer.txt': '7\n' } }, fail: { files: { 'answer.txt': '6\n' } } },
      'shell-listing': { pass: { events: [bashCall] }, fail: {} },
    },
  })
})
