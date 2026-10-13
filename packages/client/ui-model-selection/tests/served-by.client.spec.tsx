// @vitest-environment jsdom
/**
 * The served-by caption names the model and effort that served a reply with the menu's display names, and leaves out
 * a model the directory cannot name instead of showing an internal id.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { zh } from '../src/client/locales.ts'
import { describeSelection, joinLabel } from '../src/client/labels.ts'
import { ServedByCaption } from '../src/client/ServedByCaption.tsx'
import type { ModelDirectoryState } from '../src/client/directory.ts'

afterEach(() => {
  cleanup()
  failures = []
  shown = groups
})

const reasoning = { efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '极高' }], defaultEffort: 'high' }
const groups: ModelDirectoryState['groups'] = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning }, { id: 'plain', name: 'Plain' }] },
  { id: 'dsh-physical-operator', name: 'Native', models: [{ id: 'codex', name: 'Codex' }] },
]

let failures: ModelDirectoryState['failures'] = []
let shown: ModelDirectoryState['groups'] = groups

const t = ((key: string, params?: Record<string, string>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? '')
}) as ComponentProps<typeof ServedByCaption>['t']

const caption = (served: ComponentProps<typeof ServedByCaption>['served']) =>
  render(<ServedByCaption {...{ messageId: 'm', served, useDirectory: (select: (state: ModelDirectoryState) => unknown) => select({ groups: shown, failures } as ModelDirectoryState), t } as unknown as ComponentProps<typeof ServedByCaption>} />)

describe('ServedByCaption', () => {
  it('shows the display name and the effort name, with the same text as its tooltip', () => {
    caption({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    const node = screen.getByText('DeepSeek-V4-Pro · 极高')
    expect(node.getAttribute('title')).toBe('这条回复使用的模型：DeepSeek-V4-Pro · 极高')
  })

  it('shows the model alone when the reply ran without an effort, and the effort id when the model lists no such level', () => {
    caption({ provider: 'deepseek-official', model: 'plain' })
    expect(screen.getByText('Plain')).toBeTruthy()
    cleanup()
    caption({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'ultra' })
    expect(screen.getByText('DeepSeek-V4-Pro · ultra')).toBeTruthy()
  })

  it('names a native model by its operator entry and model name', () => {
    caption({ provider: 'dsh-physical-operator', model: 'codex:gpt-5.6-sol', reasoningEffort: 'low' })
    expect(screen.getByText('Codex · gpt-5.6-sol · low')).toBeTruthy()
  })

  it('names a native operator that is only a not-yet-refreshed failure row', () => {
    shown = groups.slice(0, 1)
    failures = [{ id: 'native:codex', name: 'Codex', message: 'not refreshed' }]
    caption({ provider: 'dsh-physical-operator', model: 'codex:gpt-5.6-sol', reasoningEffort: 'low' })
    expect(screen.getByText('Codex · gpt-5.6-sol · low')).toBeTruthy()
  })

  it('names a native operator that a refreshed catalog lists only through its model rows', () => {
    shown = [{ id: 'dsh-physical-operator', name: 'Native', models: [{ id: 'codex:fake-main', name: 'Codex · Fake Main', sourceName: 'Codex' }] }]
    caption({ provider: 'dsh-physical-operator', model: 'codex:gpt-5.6-sol', reasoningEffort: 'low' })
    expect(screen.getByText('Codex · gpt-5.6-sol · low')).toBeTruthy()
  })

  it('renders nothing when the reply recorded no configuration, or the directory cannot name the model', () => {
    expect(caption(undefined).container.textContent).toBe('')
    cleanup()
    expect(caption({ provider: 'deepseek-official', model: 'unknown-model' }).container.textContent).toBe('')
    cleanup()
    expect(caption({ provider: 'dsh-physical-operator', model: 'claude-code:sonnet' }).container.textContent).toBe('')
    cleanup()
    expect(caption({ provider: 'dsh-physical-operator', model: 'codex' }).container.textContent).toBe('Codex')
  })
})

describe('describeSelection', () => {
  it('reports whether the directory names the model', () => {
    expect(describeSelection({ groups, failures: [] }, { provider: 'deepseek-official', model: 'plain' })).toEqual({ model: 'Plain', named: true })
    expect(describeSelection({ groups, failures: [] }, { provider: 'x', model: 'a:b' })).toEqual({ model: 'b', named: false })
    expect(joinLabel({ model: 'M', effort: 'E', named: true })).toBe('M · E')
    expect(joinLabel({ model: 'M', named: true })).toBe('M')
  })
})
