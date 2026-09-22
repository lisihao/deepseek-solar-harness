import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { taskTemplateId } from '../src/brand.ts'
import { compareCandidates, selectTaskTemplate } from '../src/selection.ts'
import { renderTaskTemplateMethod, taskTemplateContentSha256, taskTemplateRenderVariables } from '../src/render.ts'
import type { TaskAttributes, TaskTemplate, TaskTemplateCandidate, TaskTemplatePersonalization } from '../src/types.ts'
import { MemoryTaskTemplates } from './memory.ts'

/** Fictional task attributes covering every dimension. */
function attrs(overrides: Partial<TaskAttributes> = {}): TaskAttributes {
  return {
    taskType: 'code-review',
    domain: 'frontend',
    objective: 'Review the fictional widget module for defects',
    outputFormat: 'markdown-report',
    riskLevel: 'medium',
    tools: ['read', 'grep'],
    skills: ['review-checklist'],
    operators: ['local-runner'],
    language: 'en',
    priority: 'normal',
    ...overrides,
  }
}

/** Fictional template record with wildcard match unless overridden. */
function template(id: string, overrides: Partial<Omit<TaskTemplate, 'id'>> = {}): TaskTemplate {
  return {
    id: taskTemplateId(id),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    name: id,
    rank: 0,
    match: {},
    method: `Fictional method for ${id}.`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: [],
    ...overrides,
  }
}

const NO_PERSONALIZATION: ReadonlyMap<string, TaskTemplatePersonalization> = new Map()

describe('deterministic filtering', () => {
  it('filters each constrained dimension against the task attributes', () => {
    const templates = [
      template('fixture-type-match', { match: { taskTypes: ['code-review'] } }),
      template('fixture-type-miss', { match: { taskTypes: ['research'] } }),
      template('fixture-risk-miss', { match: { riskLevels: ['critical'] } }),
      template('fixture-tools-match', { match: { requiredTools: ['read', 'grep'] } }),
      template('fixture-tools-miss', { match: { requiredTools: ['browser'] } }),
      template('fixture-operator-match', { match: { operators: ['local-runner', 'remote-runner'] } }),
      template('fixture-operator-miss', { match: { operators: ['gpu-runner'] } }),
      template('fixture-keyword-match', { match: { objectiveKeywords: ['WIDGET', 'defects'] } }),
      template('fixture-keyword-miss', { match: { objectiveKeywords: ['deployment'] } }),
      template('fixture-language-miss', { match: { languages: ['zh'] } }),
    ]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(selection.candidates.map(candidate => candidate.id).sort()).toEqual([
      'fixture-keyword-match',
      'fixture-operator-match',
      'fixture-tools-match',
      'fixture-type-match',
    ])
  })

  it('never lists a disabled template as a candidate', () => {
    const templates = [
      template('fixture-disabled', { enabled: false }),
      template('fixture-enabled'),
    ]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(selection.candidates.map(candidate => candidate.id)).toEqual(['fixture-enabled'])
  })
})

describe('deterministic ordering', () => {
  it('orders by specificity, then rank, then name, then id', () => {
    const templates = [
      template('fixture-b', { name: 'shared-name' }),
      template('fixture-a', { name: 'shared-name' }),
      template('fixture-late-name', { name: 'zeta' }),
      template('fixture-ranked', { name: 'alpha', rank: 5 }),
      template('fixture-specific', {
        name: 'alpha',
        match: { taskTypes: ['code-review'], domains: ['frontend'] },
      }),
    ]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(selection.candidates.map(candidate => candidate.id)).toEqual([
      'fixture-specific',
      'fixture-ranked',
      'fixture-a',
      'fixture-b',
      'fixture-late-name',
    ])
    expect(selection.selected?.id).toBe('fixture-specific')
    expect(selection.overrideSource).toBe('automatic')
  })

  it('returns an identical outcome for identical inputs', () => {
    const templates = [
      template('fixture-one', { match: { taskTypes: ['code-review'] } }),
      template('fixture-two', { rank: 2 }),
    ]
    const first = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    const second = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(second).toEqual(first)
  })

  it('orders both id directions and equality after all earlier keys tie', () => {
    const candidate = (id: string): TaskTemplateCandidate => ({
      id: taskTemplateId(id),
      version: 1,
      name: 'same-name',
      specificity: 1,
      rank: 0,
    })
    const a = candidate('fixture-a')
    const b = candidate('fixture-b')
    expect(compareCandidates(a, b)).toBeLessThan(0)
    expect(compareCandidates(b, a)).toBeGreaterThan(0)
    expect(compareCandidates(a, a)).toBe(0)
  })
})

describe('explicit override', () => {
  it('overrides automatic ranking, even for a template that does not match', () => {
    const templates = [
      template('fixture-auto', { match: { taskTypes: ['code-review'] } }),
      template('fixture-manual', { match: { taskTypes: ['research'] } }),
    ]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, {
      attributes: attrs(),
      explicitTemplateId: taskTemplateId('fixture-manual'),
    })
    expect(selection.decision).toBe('inject')
    expect(selection.overrideSource).toBe('explicit')
    expect(selection.selected?.id).toBe('fixture-manual')
    expect(selection.candidates.map(candidate => candidate.id)).toEqual(['fixture-auto'])
    expect(selection.rationale[0]).toMatch(/explicit template "fixture-manual" version 1 overrides/)
    expect(selection.receipt.overrideSource).toBe('explicit')
    expect(selection.receipt.templateName).toBe('fixture-manual')
  })

  it('fails loud on an unknown or disabled explicit template', () => {
    const templates = [template('fixture-disabled', { enabled: false })]
    expect(() => selectTaskTemplate(templates, NO_PERSONALIZATION, {
      attributes: attrs(),
      explicitTemplateId: taskTemplateId('fixture-missing'),
    })).toThrow(/does not exist/)
    expect(() => selectTaskTemplate(templates, NO_PERSONALIZATION, {
      attributes: attrs(),
      explicitTemplateId: taskTemplateId('fixture-disabled'),
    })).toThrow(/is disabled/)
  })
})

describe('no match means no injection', () => {
  it('skips with an empty candidate list and a skip receipt', () => {
    const templates = [template('fixture-research-only', { match: { taskTypes: ['research'] } })]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(selection.decision).toBe('skip')
    expect(selection.overrideSource).toBe('none')
    expect(selection.selected).toBeUndefined()
    expect(selection.candidates).toEqual([])
    expect(selection.rationale).toEqual(['no enabled template matches the task attributes; nothing is injected'])
    expect(selection.receipt.decision).toBe('skip')
    expect(selection.receipt.templateId).toBeUndefined()
    expect(selection.receipt.layers).toBeUndefined()
  })
})

describe('injection receipt', () => {
  it('carries the candidates, rationale, template id/version, override source, and attribute echo', () => {
    const templates = [
      template('fixture-winner', { version: 3, match: { taskTypes: ['code-review'] } }),
      template('fixture-runner-up'),
    ]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    expect(selection.receipt).toMatchObject({
      receiptVersion: 1,
      decision: 'inject',
      overrideSource: 'automatic',
      templateId: 'fixture-winner',
      templateVersion: 3,
      templateName: 'fixture-winner',
      layers: { method: true, preferences: false, memory: false },
      renderedContent: { method: 'Fictional method for fixture-winner.' },
      renderVariables: {
        objective: 'Review the fictional widget module for defects',
        taskType: 'code-review',
        domain: 'frontend',
        outputFormat: 'markdown-report',
        language: 'en',
      },
      attributes: attrs(),
    })
    expect(selection.receipt.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(selection.receipt.contentSha256).toBe(selection.selected?.contentSha256)
    expect(selection.receipt.contentSha256).toBe(taskTemplateContentSha256(selection.selected!.content))
    expect(selection.receipt.candidates.map(candidate => candidate.id))
      .toEqual(['fixture-winner', 'fixture-runner-up'])
    expect(selection.receipt.rationale[0]).toMatch(/selected "fixture-winner" version 3 by deterministic ranking/)
  })

  it('survives a JSON round trip unchanged', () => {
    const templates = [template('fixture-winner', { match: { taskTypes: ['code-review'] } })]
    const personalization = new Map([['fixture-winner', { preferences: 'Fictional preference.' }]])
    const selection = selectTaskTemplate(templates, personalization, { attributes: attrs() })
    expect(JSON.parse(JSON.stringify(selection.receipt))).toEqual(selection.receipt)
  })
})

describe('controlled method variables', () => {
  it('renders a method whose first token is a variable', () => {
    expect(renderTaskTemplateMethod('{{objective}}', taskTemplateRenderVariables(attrs())))
      .toBe('Review the fictional widget module for defects')
  })

  it('renders the fixed task vocabulary and records exact reconstruction fields', () => {
    const templates = [template('fixture-rendered', {
      method: [
        'Goal: {{objective}}',
        'Type/domain: {{taskType}}/{{domain}}',
        'Deliver: {{outputFormat}} in {{language}}',
      ].join('\n'),
    })]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    const expected = [
      'Goal: Review the fictional widget module for defects',
      'Type/domain: code-review/frontend',
      'Deliver: markdown-report in en',
    ].join('\n')
    expect(selection.selected?.content.method).toBe(expected)
    expect(selection.receipt.renderedContent?.method).toBe(expected)
    expect(selection.receipt.renderVariables).toEqual(selection.selected?.renderVariables)
    expect(selection.receipt.contentSha256).toBe(taskTemplateContentSha256({ method: expected }))
  })

  it('does not rescan inserted values as template expressions', () => {
    const templates = [template('fixture-one-pass', { method: 'Goal: {{objective}}' })]
    const selection = selectTaskTemplate(templates, NO_PERSONALIZATION, {
      attributes: attrs({ objective: 'Keep {{domain}} as literal task data' }),
    })
    expect(selection.selected?.content.method).toBe('Goal: Keep {{domain}} as literal task data')
  })

  it('fails loud on unsupported, malformed, or empty referenced values', () => {
    expect(() => selectTaskTemplate(
      [template('fixture-unknown', { method: 'Use {{shell}}.' })],
      NO_PERSONALIZATION,
      { attributes: attrs() },
    )).toThrow(/unsupported variable "shell"/)
    expect(() => selectTaskTemplate(
      [template('fixture-unclosed', { method: 'Use {{objective.' })],
      NO_PERSONALIZATION,
      { attributes: attrs() },
    )).toThrow(/unclosed/)
    expect(() => selectTaskTemplate(
      [template('fixture-empty-value', { method: 'Domain: {{domain}}' })],
      NO_PERSONALIZATION,
      { attributes: attrs({ domain: '  ' }) },
    )).toThrow(/variable "domain" has no value/)
  })

  it('changes the content hash when rendered task data or a personal layer changes', () => {
    const templates = [template('fixture-hash', { method: 'Goal: {{objective}}' })]
    const first = selectTaskTemplate(templates, NO_PERSONALIZATION, { attributes: attrs() })
    const changedTask = selectTaskTemplate(templates, NO_PERSONALIZATION, {
      attributes: attrs({ objective: 'Review a different fictional module' }),
    })
    const changedPersonal = selectTaskTemplate(
      templates,
      new Map([['fixture-hash', { preferences: 'Fictional concise style.' }]]),
      { attributes: attrs() },
    )
    expect(changedTask.receipt.contentSha256).not.toBe(first.receipt.contentSha256)
    expect(changedPersonal.receipt.contentSha256).not.toBe(first.receipt.contentSha256)
  })
})

describe('personal layering', () => {
  it('overlays stored preference and memory content and flags the layers', () => {
    const templates = [template('fixture-winner')]
    const personalization = new Map([[
      'fixture-winner',
      { preferences: 'Fictional preference: concise findings.', memory: 'Fictional memory: prior fixture run.' },
    ]])
    const selection = selectTaskTemplate(templates, personalization, { attributes: attrs() })
    expect(selection.selected?.content).toEqual({
      method: 'Fictional method for fixture-winner.',
      preferences: 'Fictional preference: concise findings.',
      memory: 'Fictional memory: prior fixture run.',
    })
    expect(selection.receipt.layers).toEqual({ method: true, preferences: true, memory: true })
  })
})

describe('service selection interface', () => {
  it('selects over the committed store through ctx.taskTemplates', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MemoryTaskTemplates)
    await fiber
    const provider = ctx.get('taskTemplates') as MemoryTaskTemplates
    await provider.create({
      id: taskTemplateId('fixture-service'),
      name: 'Fictional service template',
      match: { taskTypes: ['code-review'] },
      method: 'Fictional method from the service.',
    })
    await provider.personalize(taskTemplateId('fixture-service'), { preferences: 'Fictional preference.' })

    const selection = provider.select({ attributes: attrs() })
    expect(selection.decision).toBe('inject')
    expect(selection.selected?.id).toBe('fixture-service')
    expect(selection.selected?.content.preferences).toBe('Fictional preference.')

    const skip = provider.select({ attributes: attrs({ taskType: 'research' }) })
    expect(skip.decision).toBe('skip')
  })
})
