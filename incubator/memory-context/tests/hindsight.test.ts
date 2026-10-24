import { readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { COMPACT_HINDSIGHT_GUIDE, compactHindsightText, knownHindsightGuideHash, projectHindsightMessage } from '../src/hindsight.js'

// Generated offline by the installed 0.8.1 pure guide builders using synthetic
// page IDs. These are public tool-guide outputs, not account memories or logs.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hindsight-0.8.1-guides.json', import.meta.url), 'utf8')) as Array<{
  kind: string; count: number; reflectOnNewGoals: boolean; text: string; sha256: string
}>
const knowledge = fixtures.find(value => value.kind === 'knowledge' && value.count === 5 && value.reflectOnNewGoals)!.text
const refresh = fixtures.find(value => value.kind === 'refresh' && value.count === 5 && value.reflectOnNewGoals)!.text

describe('verified Hindsight resident guide projection', () => {
  it.each(fixtures)('recognizes generated $kind count=$count goals=$reflectOnNewGoals without matching page bodies', fixture => {
    expect(knownHindsightGuideHash(fixture.text)).toBe(fixture.sha256)
    const projected = compactHindsightText(fixture.text)!
    expect(projected.text).toBe(COMPACT_HINDSIGHT_GUIDE)
    // An empty roster refresh omits the count; absence must not be invented as 0.
    expect(projected.reportedPageCounts).toEqual(fixture.kind === 'refresh' && fixture.count === 0 ? [] : [fixture.count])
    expect(Buffer.byteLength(projected.text)).toBeLessThan(Buffer.byteLength(fixture.text))
  })

  it('normalizes only a variable page count and keeps a single compact guide for duplicate refreshes', () => {
    const projected = compactHindsightText(knowledge.replace('5 knowledge pages', '1477 knowledge pages') + '\n' + refresh)!
    expect(projected.recognizedGuideHashes).toHaveLength(2)
    expect(projected.reportedPageCounts).toEqual([1477, 5])
    expect(projected.text).toBe(COMPACT_HINDSIGHT_GUIDE + '\n')
  })

  it('preserves factual recall before and after a known guide byte-for-byte', () => {
    const prefix = '<hindsight_memories>合成事实：预算1800元。</hindsight_memories>\n'
    const suffix = '\n<relevant_memories>Test ID HN-42.</relevant_memories>'
    expect(compactHindsightText(prefix + knowledge + suffix)!.text).toBe(prefix + COMPACT_HINDSIGHT_GUIDE + suffix)
    expect(compactHindsightText(prefix + knowledge + suffix, false)!.text).toBe(prefix + suffix)
  })

  it('preserves custom guide additions, unknown versions and factual-only messages', () => {
    const custom = knowledge.replace('</hindsight_knowledge>', 'Custom repository instruction.\n</hindsight_knowledge>')
    expect(compactHindsightText(custom)).toBeUndefined()
    expect(compactHindsightText(knowledge.replace('Hindsight memory + knowledge base', 'Hindsight vNext memory'))).toBeUndefined()
    expect(compactHindsightText('<hindsight_memories>synthetic fact</hindsight_memories>')).toBeUndefined()
  })

  it('requires exact automatic producer provenance and leaves original source messages intact', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: knowledge }], source: { kind: 'user' } })
    expect(projectHindsightMessage(user)).toBeUndefined()
    const automatic = createUserMessage({ content: [{ type: 'text', text: knowledge + '\n' + refresh }], source: { kind: 'plugin:hindsight', form: 'recall' } as never })
    const before = JSON.stringify(automatic)
    const projected = projectHindsightMessage(automatic)!
    expect(projected.content).toEqual([{ type: 'text', text: COMPACT_HINDSIGHT_GUIDE + '\n' }])
    expect(projected.source).toMatchObject({ kind: 'plugin:hindsight', form: 'recall', solarHindsightContext: { formatVersion: 1, policyVersion: 1, includesCompactGuide: true } })
    expect(JSON.stringify(automatic)).toBe(before)
    expect(projectHindsightMessage(projected)).toBeUndefined()
  })
})
