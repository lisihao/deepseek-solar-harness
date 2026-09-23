import { describe, expect, it } from 'vitest'
import { taskTemplateId } from '../src/brand.ts'
import {
  TaskTemplateStoreError,
  diffStoreDocuments,
  parseStoreDocument,
  validateMatch,
} from '../src/store.ts'
import type { TaskTemplate, TaskTemplateStoreDocument } from '../src/index.ts'

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

function document(templates: TaskTemplate[]): TaskTemplateStoreDocument {
  return { formatVersion: 1, templates, personalization: {} }
}

function parse(value: unknown): TaskTemplateStoreDocument {
  return parseStoreDocument(JSON.stringify(value), 'fixture-store.json')
}

describe('store validation details', () => {
  it('rejects every non-plain root representation', () => {
    for (const value of [null, [], 1]) {
      expect(() => parse(value)).toThrow(/\$ must be an object/)
    }
    expect(() => validateMatch(new Date(), 'fixture match')).toThrow(/must be an object/)
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { domains: ['frontend'] })
    expect(validateMatch(nullPrototype, 'fixture match')).toEqual({ domains: ['frontend'] })
  })

  it('validates closed match lists, duplicate lists, and canonical instants', () => {
    expect(validateMatch({ riskLevels: ['high'], priorities: ['urgent'] }, 'fixture match'))
      .toEqual({ riskLevels: ['high'], priorities: ['urgent'] })
    expect(() => validateMatch({ riskLevels: ['unknown'] }, 'fixture match')).toThrow(/allowed:/)
    expect(() => validateMatch({ taskTypes: ['review', 'review'] }, 'fixture match')).toThrow(/must not contain duplicates/)

    for (const createdAt of ['not-an-instant', '2026-01-01T00:00:00Z']) {
      expect(() => parse(document([template('fixture-time', { createdAt })])))
        .toThrow(/canonical ISO-8601 UTC instant/)
    }
  })

  it('rejects malformed template and revision containers', () => {
    expect(() => parse({ formatVersion: 1, templates: {}, personalization: {} }))
      .toThrow(/templates must be an array/)
    expect(() => parse({ formatVersion: 1, templates: [null], personalization: {} }))
      .toThrow(/must be a template object/)
    expect(() => parse(document([template('fixture-enabled', { enabled: 'yes' as unknown as boolean })])))
      .toThrow(/enabled must be a boolean/)
    expect(() => parse(document([template('fixture-history', { history: {} as unknown as [] })])))
      .toThrow(/history must be an array/)
    expect(() => parse({
      formatVersion: 1,
      templates: [{ ...template('fixture-id'), id: 'Bad_ID' }],
      personalization: {},
    })).toThrow(/must match/)

    const missingHistory = template('fixture-missing-history', { version: 2 })
    expect(() => parse(document([missingHistory])))
      .toThrow(/history must contain every superseded version/)
    const nullRevision = template('fixture-null-revision', {
      version: 2,
      history: [null as unknown as TaskTemplate['history'][number]],
    })
    expect(() => parse(document([nullRevision]))).toThrow(/must be a revision object/)
    const misnumbered = template('fixture-misnumbered', {
      version: 2,
      history: [{
        version: 2,
        name: 'Old fixture',
        rank: 0,
        match: {},
        method: 'Old method.',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    expect(() => parse(document([misnumbered]))).toThrow(/version must be 1/)
  })

  it('rejects duplicate ids and malformed personalization containers', () => {
    const duplicate = template('fixture-duplicate')
    expect(() => parse(document([duplicate, structuredClone(duplicate)]))).toThrow(/duplicate template id/)
    expect(() => parse({ formatVersion: 1, templates: [], personalization: [] }))
      .toThrow(/personalization must be an object/)
    expect(() => parse({ formatVersion: 1, templates: [], personalization: { ghost: null } }))
      .toThrow(/names an unknown template/)
    expect(() => parse({
      formatVersion: 1,
      templates: [template('fixture-personal')],
      personalization: { 'fixture-personal': null },
    })).toThrow(/must be an object with/)
  })

  it('retains the stable store error identity', () => {
    const error = new TaskTemplateStoreError('fixture failure')
    expect(error).toMatchObject({ name: 'TaskTemplateStoreError', code: 'TASK_TEMPLATE_STORE' })
  })
})

describe('external document diff', () => {
  it('reports create, update, both enablement directions, personalization, delete, and no change', () => {
    const original = template('fixture-original')
    const removed = template('fixture-removed')
    const before = document([original, removed])
    before.personalization[original.id] = { preferences: 'Old preference.' }

    const updated = template('fixture-original', {
      version: 2,
      method: 'Updated method.',
      history: [{
        version: 1,
        name: original.name,
        rank: original.rank,
        match: original.match,
        method: original.method,
        updatedAt: original.updatedAt,
      }],
    })
    const created = template('fixture-created')
    const after = document([updated, created])
    after.personalization[updated.id] = { preferences: 'New preference.' }
    expect(diffStoreDocuments(before, after)).toEqual([
      { id: updated.id, kind: 'update', version: 2 },
      { id: created.id, kind: 'create', version: 1 },
      { id: removed.id, kind: 'delete', version: 1 },
    ])

    const enabled = template('fixture-enabled')
    const disabled = template('fixture-disabled', { enabled: false })
    expect(diffStoreDocuments(document([disabled]), document([{ ...disabled, enabled: true }]))).toEqual([
      { id: disabled.id, kind: 'enable', version: 1 },
    ])
    expect(diffStoreDocuments(document([enabled]), document([{ ...enabled, enabled: false }]))).toEqual([
      { id: enabled.id, kind: 'disable', version: 1 },
    ])

    const personalizedBefore = document([template('fixture-personalized')])
    const personalizedAfter = structuredClone(personalizedBefore)
    personalizedAfter.personalization['fixture-personalized'] = { memory: 'Fictional memory.' }
    expect(diffStoreDocuments(personalizedBefore, personalizedAfter)).toEqual([
      { id: taskTemplateId('fixture-personalized'), kind: 'personalize', version: 1 },
    ])
    expect(diffStoreDocuments(personalizedAfter, structuredClone(personalizedAfter))).toEqual([])
  })
})
