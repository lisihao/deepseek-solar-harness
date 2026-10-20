import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReplayRegistry } from '../src/replay.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: 'same output',
    reasoning_content: 'same reasoning',
    tool_calls: [],
    ...overrides,
  }
}

function journal(value: unknown): string {
  return JSON.stringify({ formatVersion: 1, time: '2026-10-20T00:00:00.000Z', value })
}

describe('ReplayRegistry', () => {
  it('marks same wire content with different provider state ambiguous instead of overwriting it', () => {
    const registry = new ReplayRegistry()
    registry.record(assistant(), { response: { signature: 'first' } })
    registry.record(assistant({ ignored_by_replay_key: true }), { response: { signature: 'second' } })

    expect(() => registry.forMessage(assistant())).toThrow('RLM_REPLAY_AMBIGUOUS')
    expect(registry.highestModelOrdinal()).toBe(0)
  })

  it('reuses the first original state when canonical provider state is equal', () => {
    const registry = new ReplayRegistry()
    const original = { response: { id: 'req-1', details: { b: 2, a: 1 } } }
    registry.record(assistant(), original)
    registry.record(assistant(), { response: { details: { a: 1, b: 2 }, id: 'req-1' } })

    expect(registry.forMessage(assistant())).toBe(original)
  })

  it('uses the same nullish identity normalization as the current core replay key', () => {
    const registry = new ReplayRegistry()
    const state = { response: { id: 'normalized-empty-wire-fields' } }
    registry.record({ role: 'assistant', content: null }, state)

    expect(registry.forMessage({
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [],
    })).toBe(state)
  })

  it('keys every tool call and its raw argument string in order', () => {
    const registry = new ReplayRegistry()
    const message = assistant({
      tool_calls: [
        { id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
        { id: 'call-write', type: 'function', function: { name: 'write', arguments: '{"path":"b.txt","value":0}' } },
      ],
    })
    const state = { response: { cursor: 'tool-roundtrip' } }
    registry.record(message, state)

    expect(registry.forMessage(JSON.parse(JSON.stringify(message)))).toBe(state)
    expect(registry.forMessage(assistant({
      tool_calls: [
        { id: 'call-write', type: 'function', function: { name: 'write', arguments: '{"path":"b.txt","value":0}' } },
        { id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
      ],
    }))).toBeUndefined()
    expect(registry.forMessage(assistant({
      tool_calls: [
        { id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
        { id: 'call-write', type: 'function', function: { name: 'write', arguments: '{"value":0,"path":"b.txt"}' } },
      ],
    }))).toBeUndefined()
  })

  it('restores only replay-bearing model settlements and accepts a missing first journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-replay-'))
    directories.push(directory)
    const journalPath = join(directory, 'journal.jsonl')
    const message = assistant({ content: 'restored output', reasoning_content: '' })
    const state = { response: { providerCursor: 'persisted' }, blocks: [{ encrypted: true }] }
    await writeFile(journalPath, [
      journal({ type: 'turn-intent', text: 'ignored known event' }),
      journal({ type: 'model-settlement', value: { message: assistant({ content: 'without state' }), finishReason: 'stop' } }),
      journal({ type: 'model-chunk', chunk: { type: 'text-delta', index: 0, text: 'ignored known event' } }),
      journal({ type: 'model-settlement', value: { message, replayState: state, finishReason: 'stop' } }),
    ].join('\n') + '\n')

    const registry = new ReplayRegistry()
    await registry.restore(journalPath)
    expect(registry.forMessage(message)).toEqual(state)
    expect(registry.forMessage(assistant({ content: 'without state' }))).toBeUndefined()

    registry.record(assistant(), { response: 'discarded when no journal exists' })
    await registry.restore(join(directory, 'first-run-missing.jsonl'))
    expect(registry.forMessage(assistant())).toBeUndefined()
  })

  it('keeps conflicting replay signatures ambiguous after journal restoration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-replay-conflict-'))
    directories.push(directory)
    const journalPath = join(directory, 'journal.jsonl')
    const message = assistant({ content: 'historical duplicate' })
    await writeFile(journalPath, [
      journal({ type: 'model-settlement', value: { message, replayState: { response: { signature: 'old' } } } }),
      journal({ type: 'model-settlement', value: { message, replayState: { response: { signature: 'new' } } } }),
    ].join('\n') + '\n')

    const registry = new ReplayRegistry()
    await registry.restore(journalPath)
    expect(() => registry.forMessage(message)).toThrow('RLM_REPLAY_AMBIGUOUS')
  })

  it('restores the highest monotonic model-intent ordinal for conservative resume accounting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-replay-ordinal-'))
    directories.push(directory)
    const journalPath = join(directory, 'journal.jsonl')
    await writeFile(journalPath, [
      journal({ type: 'model-intent', ordinal: 1 }),
      journal({ type: 'model-dispatch', config: { ignoredForAccounting: true } }),
      journal({ type: 'model-intent', ordinal: 2 }),
    ].join('\n') + '\n')

    const registry = new ReplayRegistry()
    await registry.restore(journalPath)
    const manifestCount = 1
    expect(registry.highestModelOrdinal()).toBe(2)
    expect(Math.max(manifestCount, registry.highestModelOrdinal())).toBe(2)
  })

  it('rejects duplicate, descending, and invalid model-intent ordinals atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-replay-invalid-ordinal-'))
    directories.push(directory)
    const stablePath = join(directory, 'stable.jsonl')
    const message = assistant({ content: 'preserve-after-invalid-restore' })
    const state = { response: { signature: 'stable' } }
    await writeFile(stablePath, [
      journal({ type: 'model-intent', ordinal: 2 }),
      journal({ type: 'model-settlement', value: { message, replayState: state } }),
    ].join('\n') + '\n')

    const registry = new ReplayRegistry()
    await registry.restore(stablePath)
    const restoredState = registry.forMessage(message)
    expect(restoredState).toEqual(state)
    const invalidJournals = [
      [journal({ type: 'model-intent', ordinal: 1 }), journal({ type: 'model-intent', ordinal: 1 })],
      [journal({ type: 'model-intent', ordinal: 2 }), journal({ type: 'model-intent', ordinal: 1 })],
      [journal({ type: 'model-intent', ordinal: 0 })],
    ]
    for (const [index, lines] of invalidJournals.entries()) {
      const journalPath = join(directory, `invalid-${index}.jsonl`)
      await writeFile(journalPath, lines.join('\n') + '\n')
      await expect(registry.restore(journalPath)).rejects.toThrow('RLM_REPLAY_FORMAT')
      expect(registry.highestModelOrdinal()).toBe(2)
      expect(registry.forMessage(message)).toBe(restoredState)
    }
  })

  it('rejects unknown durable formats, event types, and a truncated JSONL line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-replay-invalid-'))
    directories.push(directory)
    const versionPath = join(directory, 'version.jsonl')
    await writeFile(versionPath, JSON.stringify({ formatVersion: 2, time: '2026-10-20T00:00:00.000Z', value: { type: 'turn-intent' } }) + '\n')
    await expect(new ReplayRegistry().restore(versionPath)).rejects.toThrow('RLM_REPLAY_FORMAT')

    const unknownPath = join(directory, 'unknown.jsonl')
    await writeFile(unknownPath, journal({ type: 'future-event' }) + '\n')
    await expect(new ReplayRegistry().restore(unknownPath)).rejects.toThrow('unknown event type')

    const partialPath = join(directory, 'partial.jsonl')
    await writeFile(partialPath, '{"formatVersion":1,"time":"2026-10-20T00:00:00.000Z","value":')
    await expect(new ReplayRegistry().restore(partialPath)).rejects.toThrow('partial JSONL line')
  })
})
