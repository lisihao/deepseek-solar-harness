import { describe, expect, it } from 'vitest'
import {
  studioDraftSaveStatus,
  workflowStudioPresentation,
  workflowStudioRunAction,
} from '../src/studio-client.js'
import type { EditableStudioDraft } from '../src/studio-client-helpers.js'
import type { StudioDraft, StudioGraph, StudioOverview } from '../src/studio-contract.js'

function graph(): StudioGraph {
  return {
    formatVersion: 1,
    id: 'flow-a',
    sessionId: 'session-a',
    providerId: 'native',
    title: '当前流程',
    nodes: [],
    edges: [],
    parameters: {},
    metadata: {},
  }
}

function draft(expectedRevision = 0): EditableStudioDraft {
  return { id: 'draft-a', expectedRevision, graph: graph() }
}

function savedDraft(revision = 0): StudioDraft {
  return {
    formatVersion: 1,
    id: 'draft-a',
    revision,
    graph: graph(),
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  }
}

function choices(drafts: readonly StudioDraft[] = []): Pick<StudioOverview, 'sources' | 'drafts'> {
  return { sources: [], drafts }
}

describe('workflow studio presentation', () => {
  it('uses a single explanatory empty state only after a successful empty overview', () => {
    expect(workflowStudioPresentation({
      overview: choices(),
      draft: undefined,
      loading: false,
      apiAvailable: true,
      hasServiceError: false,
      hasOverviewError: false,
    })).toBe('empty')

    expect(workflowStudioPresentation({
      overview: choices(),
      draft: undefined,
      loading: true,
      apiAvailable: true,
      hasServiceError: false,
      hasOverviewError: false,
    })).toBe('loading')

    expect(workflowStudioPresentation({
      overview: choices(),
      draft: undefined,
      loading: false,
      apiAvailable: true,
      hasServiceError: true,
      hasOverviewError: false,
    })).toBe('unavailable')
  })

  it('opens selection only when sources or saved drafts exist, and keeps a selected draft in the editor', () => {
    expect(workflowStudioPresentation({
      overview: choices([savedDraft(0)]),
      draft: undefined,
      loading: false,
      apiAvailable: true,
      hasServiceError: false,
      hasOverviewError: false,
    })).toBe('selection')

    expect(workflowStudioPresentation({
      overview: undefined,
      draft: draft(0),
      loading: true,
      apiAvailable: true,
      hasServiceError: false,
      hasOverviewError: false,
    })).toBe('editor')
  })

  it('does not infer an unsaved draft from revision zero alone', () => {
    expect(studioDraftSaveStatus(draft(0), choices([savedDraft(0)]), false)).toBe('已保存 · 版本 0')
    expect(studioDraftSaveStatus(draft(0), choices(), false)).toBe('尚未保存')
    expect(studioDraftSaveStatus(draft(0), choices([savedDraft(0)]), true)).toBe('有未保存修改')
    expect(studioDraftSaveStatus(undefined, choices([savedDraft(0)]), false)).toBeUndefined()
  })

  it('keeps the existing save-before-run guard visible as a disabled action', () => {
    expect(workflowStudioRunAction(true, undefined, false)).toMatchObject({
      label: '保存后执行',
      disabled: true,
      hintTone: 'muted',
    })
    expect(workflowStudioRunAction(false, undefined, false)).toMatchObject({
      label: '按此草稿再次执行',
      disabled: false,
      hintTone: 'warning',
    })
    expect(workflowStudioRunAction(false, 'command-a', true)).toMatchObject({
      label: '正在检查执行…',
      disabled: true,
    })
  })
})
