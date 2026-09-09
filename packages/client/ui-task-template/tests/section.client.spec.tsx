// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { TaskTemplateSection } from '../src/client/TaskTemplateSection.tsx'
import { zh, type TaskTemplateLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

describe('task-template settings section', () => {
  it('creates a template with task attributes and a separate private layer', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const empty = { version: 1, variables: ['objective'], templates: [] }
    const created = {
      version: 1, variables: ['objective'], templates: [{
        id: 'insight-report', enabled: true, createdAt: '2026-09-08T00:00:00.000Z', version: 1,
        name: '洞察报告', rank: 10, match: { taskTypes: ['insight-report'] },
        method: '分析 {{objective}}', updatedAt: '2026-09-08T00:00:00.000Z', history: [],
      }],
    }
    const personalized = {
      ...created,
      templates: [{ ...created.templates[0]!, personalization: { preferences: '中文、结论优先。' } }],
    }
    const connection = { rpc: { call: (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return Promise.resolve({ ok: true, value: endpoint === 'list' ? empty : endpoint === 'create' ? created : personalized })
    } } } as unknown as ConnectionHandle
    const t = (key: TaskTemplateLocaleKey): string => zh[key]

    render(<TaskTemplateSection connection={connection} t={t} />)
    await waitFor(() => expect(screen.getByText(zh.empty)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(new RegExp(zh.id)), { target: { value: 'insight-report' } })
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: '洞察报告' } })
    fireEvent.change(screen.getByLabelText(new RegExp(zh.rank)), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText(new RegExp(`^${zh.taskTypes}`)), { target: { value: 'insight-report' } })
    fireEvent.change(screen.getByLabelText(new RegExp(zh.method)), { target: { value: '分析 {{objective}}' } })
    fireEvent.change(screen.getByLabelText(zh.preferences), { target: { value: '中文、结论优先。' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => expect(calls.map(call => call.endpoint)).toEqual(['list', 'create', 'personalize']))
    expect(calls[1]?.payload).toMatchObject({ draft: { id: 'insight-report', match: { taskTypes: ['insight-report'] } } })
    expect(calls[2]?.payload).toEqual({ id: 'insight-report', personalization: { preferences: '中文、结论优先。' } })
    expect(await screen.findByText('insight-report')).toBeTruthy()
  })
})
