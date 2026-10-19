import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { readSavedModelSelection } from '../src/model-selection-event.ts'

function durable(data: unknown): SessionEvent[] {
  // JSONL supplies unchecked data; the reader owns its runtime validation.
  return JSON.parse(JSON.stringify([{ type: 'session/model-selection', data }])) as SessionEvent[]
}
const ordinary = { provider: 'deepseek-official', model: 'ordinary', reasoningEffort: 'max' }
const web = { provider: 'dsh-physical-operator', model: 'chatgpt-web' }
describe('durable explicit Session model selection', () => {
  it('restores exact route and effort without synthesizing absent ordinary history', () => {
    expect(readSavedModelSelection(durable({ version: 1, selected: web, ordinary })))
      .toEqual({ version: 1, selected: web, ordinary })
    expect(readSavedModelSelection(durable({ version: 1, selected: web, ordinary: null }))?.ordinary).toBeNull()
    expect(readSavedModelSelection([])).toBeUndefined()
  })
  it.each([
    { version: 2, selected: web, ordinary },
    { version: 1, selected: web },
    { version: 1, selected: { ...ordinary, reasoningEffort: 3 }, ordinary },
    { version: 1, selected: web, ordinary: web },
    { version: 1, selected: web, ordinary: { ...web, model: 'chatgpt-web:actual-choice' } },
  ])('rejects malformed or contradictory persisted data %#', (value) => {
    expect(() => readSavedModelSelection(durable(value))).toThrow()
  })
})
