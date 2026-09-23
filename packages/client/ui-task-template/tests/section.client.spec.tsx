// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { TaskTemplateSelection } from '@deepseek-ai/dsh-task-template'
import type { TaskTemplateRpcSnapshotV1, TaskTemplateView } from '@deepseek-ai/dsh-task-template-rpc/shared'
import {
  TaskTemplateSection,
  type TaskTemplateSectionProps,
} from '../src/client/TaskTemplateSection.tsx'
import { en, zh, type TaskTemplateLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type RpcResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: 'internal'; readonly message: string; readonly details: {} } }

interface RecordedCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

const AT = '2026-09-08T00:00:00.000Z'

function view(
  overrides: Partial<Omit<TaskTemplateView, 'id'>> & { readonly id?: string } = {},
): TaskTemplateView {
  return {
    id: 'insight-report',
    enabled: true,
    createdAt: AT,
    version: 1,
    name: 'Insight report',
    rank: 10,
    match: { taskTypes: ['insight-report'] },
    method: 'Analyze {{objective}}',
    updatedAt: AT,
    history: [],
    ...overrides,
  } as unknown as TaskTemplateView
}

function snapshot(templates: readonly TaskTemplateView[]): TaskTemplateRpcSnapshotV1 {
  return {
    version: 1,
    variables: ['objective', 'taskType', 'domain', 'outputFormat', 'language'],
    templates,
  }
}

function rpcHarness(
  respond: (endpoint: string, payload: unknown, callIndex: number) => RpcResponse | Promise<RpcResponse>,
): { connection: ConnectionHandle; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const connection = { rpc: { call: async (channel: string, endpoint: string, payload: unknown) => {
    calls.push({ channel, endpoint, payload })
    return respond(endpoint, payload, calls.length - 1)
  } } } as unknown as ConnectionHandle
  return { connection, calls }
}

function sectionProps(connection: ConnectionHandle, locale = en): TaskTemplateSectionProps {
  return {
    connection,
    t: (key: TaskTemplateLocaleKey): string => locale[key],
  } as unknown as TaskTemplateSectionProps
}

function renderSection(connection: ConnectionHandle, locale = en): void {
  render(<TaskTemplateSection {...sectionProps(connection, locale)} />)
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function rejectUnknown<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- RPC transports may reject with unknown values.
    reject(reason)
  })
}

function fillNewTemplate(): void {
  fireEvent.change(screen.getByLabelText(en.id), { target: { value: 'insight-report' } })
  fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'Insight report' } })
  fireEvent.change(screen.getByLabelText(en.rank), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText(en.taskTypes), { target: { value: 'insight-report, insight-report' } })
  fireEvent.change(screen.getByLabelText(en.method), { target: { value: 'Analyze {{objective}}' } })
}

function fillRemainingMatchFields(): void {
  const values: ReadonlyArray<readonly [string, string]> = [
    [en.domains, 'agents'],
    [en.keywords, 'evidence, current'],
    [en.outputFormats, 'report'],
    [en.operators, 'codex'],
    [en.tools, 'web'],
    [en.skills, 'research'],
    [en.languages, 'en'],
    [en.risks, 'high'],
    [en.priorities, 'urgent'],
  ]
  for (const [label, value] of values) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
}

describe('task-template settings section', () => {
  it('creates a disabled template and keeps personalization in its separate RPC', async () => {
    const empty = snapshot([])
    const created = snapshot([view()])
    const disabled = snapshot([view({ enabled: false })])
    const personalized = snapshot([view({
      enabled: false,
      personalization: { preferences: 'Lead with conclusions.' },
    })])
    const { connection, calls } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list'
        ? empty
        : endpoint === 'create'
          ? created
          : endpoint === 'set-enabled'
            ? disabled
            : personalized,
    }))

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole('checkbox', { name: en.availability })).toHaveProperty('checked', false)
    expect(screen.getByText(en.enabledHint)).toBeTruthy()
    fillNewTemplate()
    fireEvent.change(screen.getByLabelText(en.preferences), { target: { value: 'Lead with conclusions.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(calls.map(call => call.endpoint)).toEqual(['list', 'create', 'set-enabled', 'personalize'])
    expect(calls.every(call => call.channel === '/task-templates')).toBe(true)
    expect(calls[1]?.payload).toMatchObject({
      draft: { id: 'insight-report', match: { taskTypes: ['insight-report'] } },
    })
    expect(calls[2]?.payload).toEqual({ id: 'insight-report', enabled: false })
    expect(calls[3]?.payload).toEqual({
      id: 'insight-report',
      personalization: { preferences: 'Lead with conclusions.' },
    })
    expect(screen.getAllByText(en.disabled).length).toBeGreaterThan(0)
  })

  it('keeps a newly created template visible when disabling fails and retries only disablement', async () => {
    const empty = snapshot([])
    const created = snapshot([view()])
    const disabled = snapshot([view({ enabled: false })])
    let disableAttempts = 0
    const { connection, calls } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return { ok: true, value: empty }
      if (endpoint === 'create') return { ok: true, value: created }
      disableAttempts += 1
      return disableAttempts === 1
        ? { ok: false, error: { code: 'internal', message: 'enablement unavailable', details: {} } }
        : { ok: true, value: disabled }
    })

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(new RegExp(`${en.partialSaveFailed} enablement unavailable`))
    expect(screen.getByText('insight-report')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: en.availability })).toHaveProperty('checked', false)
    expect(screen.getByText(en.enabled)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(en.saved)
    expect(calls.map(call => call.endpoint)).toEqual(['list', 'create', 'set-enabled', 'set-enabled'])
    expect(screen.getAllByText(en.disabled).length).toBeGreaterThan(0)
  })

  it('keeps each committed snapshot visible and retries only the remaining mutation', async () => {
    const empty = snapshot([])
    const created = snapshot([view()])
    const disabled = snapshot([view({ enabled: false })])
    const personalized = snapshot([view({
      enabled: false,
      personalization: { preferences: 'Lead with conclusions.' },
    })])
    let personalizationAttempts = 0
    const { connection, calls } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return { ok: true, value: empty }
      if (endpoint === 'create') return { ok: true, value: created }
      if (endpoint === 'set-enabled') return { ok: true, value: disabled }
      personalizationAttempts += 1
      return personalizationAttempts === 1
        ? { ok: false, error: { code: 'internal', message: 'private store unavailable', details: {} } }
        : { ok: true, value: personalized }
    })

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fireEvent.change(screen.getByLabelText(en.preferences), { target: { value: 'Lead with conclusions.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(new RegExp(`${en.partialSaveFailed} private store unavailable`))
    expect(screen.getByText('insight-report')).toBeTruthy()
    expect(screen.getAllByText(en.disabled).length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('Lead with conclusions.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(en.saved)
    expect(calls.map(call => call.endpoint)).toEqual([
      'list', 'create', 'set-enabled', 'personalize', 'personalize',
    ])
  })

  it('distinguishes a rejected first mutation from a malformed committed snapshot', async () => {
    let createAttempts = 0
    const { connection } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return { ok: true, value: snapshot([]) }
      createAttempts += 1
      return createAttempts === 1
        ? rejectUnknown('create transport closed')
        : { ok: true, value: snapshot([]) }
    })

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText('create transport closed')
    expect(screen.queryByText(en.partialSaveFailed, { exact: false })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(new RegExp(`${en.partialSaveFailed} ${en.saveMissing}`))
  })

  it('sends every populated match attribute and supports memory without preferences', async () => {
    const match = {
      taskTypes: ['insight-report'],
      domains: ['agents'],
      objectiveKeywords: ['evidence', 'current'],
      outputFormats: ['report'],
      requiredTools: ['web'],
      requiredSkills: ['research'],
      operators: ['codex'],
      languages: ['en'],
      riskLevels: ['high'],
      priorities: ['urgent'],
    } as const
    const created = snapshot([view({ match })])
    const disabled = snapshot([view({ enabled: false, match })])
    const personalized = snapshot([view({
      enabled: false,
      match,
      personalization: { memory: 'Verify primary sources.' },
    })])
    const { connection, calls } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list'
        ? snapshot([])
        : endpoint === 'create'
          ? created
          : endpoint === 'set-enabled'
            ? disabled
            : personalized,
    }))

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fillRemainingMatchFields()
    fireEvent.change(screen.getByLabelText(en.memory), { target: { value: 'Verify primary sources.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(calls[1]?.payload).toMatchObject({ draft: { match } })
    expect(calls[2]?.payload).toEqual({ id: 'insight-report', enabled: false })
    expect(calls[3]?.payload).toEqual({
      id: 'insight-report',
      personalization: { memory: 'Verify primary sources.' },
    })
  })

  it('creates a broad explicitly enabled template without optional follow-up mutations', async () => {
    const created = snapshot([view({ match: {} })])
    const { connection, calls } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list' ? snapshot([]) : created,
    }))

    renderSection(connection)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fireEvent.change(screen.getByLabelText(en.taskTypes), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.availability }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(calls.map(call => call.endpoint)).toEqual(['list', 'create'])
    expect(calls[1]?.payload).toMatchObject({ draft: { match: {} } })
  })

  it('previews the saved rendered layers with accessible, field-specific guidance', async () => {
    const stored = view({
      match: {
        taskTypes: ['research'],
        domains: ['agents'],
        objectiveKeywords: ['evidence'],
        outputFormats: ['report'],
        riskLevels: ['high'],
        requiredTools: ['web'],
        requiredSkills: ['research'],
        operators: ['codex'],
        languages: ['en'],
        priorities: ['urgent'],
      },
      method: 'Research {{objective}} for {{domain}} as a {{outputFormat}}.',
      personalization: { preferences: 'Cite sources.', memory: 'Separate facts from inference.' },
    })
    const rendered = {
      decision: 'inject',
      selected: {
        content: {
          method: 'Research current evidence for agents as a report.',
          preferences: 'Cite sources.',
          memory: 'Separate facts from inference.',
        },
      },
    } as unknown as TaskTemplateSelection
    const { connection, calls } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list' ? snapshot([stored]) : rendered,
    }))

    renderSection(connection)
    fireEvent.click(await screen.findByRole('button', { name: `${en.editTitle}: Insight report` }))

    const keywordInput = screen.getByLabelText(en.keywords)
    const hintId = keywordInput.getAttribute('aria-describedby')
    expect(hintId).not.toBeNull()
    expect(document.getElementById(hintId!)?.textContent).toContain(en.keywordsHint)
    fireEvent.change(screen.getByLabelText(en.previewObjective), { target: { value: 'current evidence' } })
    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))

    await screen.findByText('Research current evidence for agents as a report.')
    const previewResult = screen.getByRole('region', { name: en.previewResult })
    expect(within(previewResult).getByText('Cite sources.')).toBeTruthy()
    expect(within(previewResult).getByText('Separate facts from inference.')).toBeTruthy()
    expect(calls.at(-1)).toEqual({
      channel: '/task-templates',
      endpoint: 'preview',
      payload: {
        id: 'insight-report',
        attributes: {
          taskType: 'research',
          domain: 'agents',
          objective: 'current evidence',
          outputFormat: 'report',
          riskLevel: 'high',
          tools: ['web'],
          skills: ['research'],
          operators: ['codex'],
          language: 'en',
          priority: 'urgent',
        },
      },
    })
  })

  it('uses safe preview defaults and reports transport or missing-selection results', async () => {
    const stored = view({ match: {}, method: 'Handle {{objective}}.' })
    let previewAttempts = 0
    const { connection, calls } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return { ok: true, value: snapshot([stored]) }
      previewAttempts += 1
      if (previewAttempts === 1) {
        return {
          ok: true,
          value: { decision: 'inject', selected: { content: { method: 'Handle Insight report.' } } },
        }
      }
      if (previewAttempts === 2) return rejectUnknown('preview transport closed')
      return { ok: true, value: { decision: 'skip' } }
    })

    renderSection(connection)
    fireEvent.click(await screen.findByRole('button', { name: `${en.editTitle}: Insight report` }))
    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))
    await screen.findByText('Handle Insight report.')
    expect(calls.at(-1)?.payload).toEqual({
      id: 'insight-report',
      attributes: {
        taskType: 'general',
        domain: 'general',
        objective: 'Insight report',
        outputFormat: 'text',
        riskLevel: 'low',
        tools: [],
        skills: [],
        operators: [],
        language: 'en',
        priority: 'normal',
      },
    })

    fireEvent.change(screen.getByLabelText(en.previewObjective), { target: { value: ' ' } })
    expect(screen.getByRole('button', { name: en.previewAction })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(en.previewObjective), { target: { value: 'Second preview' } })
    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))
    await screen.findByText('preview transport closed')
    fireEvent.change(screen.getByLabelText(en.previewObjective), { target: { value: 'Third preview' } })
    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))
    await screen.findByText(en.previewMissing)
  })

  it('clears rendered output when a saved personalization layer changes', async () => {
    const stored = view({ personalization: { preferences: 'Old saved preference.' } })
    const personalized = view({ personalization: { preferences: 'New saved preference.' } })
    let previewAttempts = 0
    const { connection } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return { ok: true, value: snapshot([stored]) }
      if (endpoint === 'personalize') return { ok: true, value: snapshot([personalized]) }
      previewAttempts += 1
      return {
        ok: true,
        value: {
          decision: 'inject',
          selected: {
            content: {
              method: 'Analyze Insight report',
              preferences: previewAttempts === 1 ? 'Old rendered preference.' : 'New rendered preference.',
            },
          },
        },
      }
    })

    renderSection(connection)
    fireEvent.click(await screen.findByRole('button', { name: `${en.editTitle}: Insight report` }))
    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))
    await screen.findByText('Old rendered preference.')

    fireEvent.change(screen.getByLabelText(en.preferences), { target: { value: 'New saved preference.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(en.saved)
    expect(screen.queryByText('Old rendered preference.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.previewAction }))
    await screen.findByText('New rendered preference.')
  })

  it('updates all layers, keeps disabled previews unavailable, and confirms deletion', async () => {
    const stored = view({ personalization: { preferences: 'Old preference.' } })
    const updated = view({ version: 2, name: 'Updated report', personalization: { preferences: 'Old preference.' } })
    const disabled = view({ version: 2, name: 'Updated report', enabled: false, personalization: { preferences: 'Old preference.' } })
    const cleared = view({ version: 2, name: 'Updated report', enabled: false })
    const { connection, calls } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list'
        ? snapshot([stored])
        : endpoint === 'update'
          ? snapshot([updated])
          : endpoint === 'set-enabled'
            ? snapshot([disabled])
            : endpoint === 'personalize'
              ? snapshot([cleared])
              : snapshot([]),
    }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)

    renderSection(connection)
    fireEvent.click(await screen.findByRole('button', { name: `${en.editTitle}: Insight report` }))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'Updated report' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.availability }))
    fireEvent.change(screen.getByLabelText(en.preferences), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(screen.getByText(en.previewEnableFirst)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.previewAction })).toHaveProperty('disabled', true)
    const remove = screen.getByRole('button', { name: `${en.remove}: Updated report` })
    fireEvent.click(remove)
    fireEvent.click(remove)
    await screen.findByText(en.deleted)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(calls.map(call => call.endpoint)).toEqual([
      'list', 'update', 'set-enabled', 'personalize', 'delete',
    ])
  })

  it('deletes a row without closing a different selection', async () => {
    const first = view({ id: 'first-template', name: 'First template' })
    const second = view({ id: 'second-template', name: 'Second template' })
    const { connection } = rpcHarness(endpoint => ({
      ok: true,
      value: endpoint === 'list' ? snapshot([first, second]) : snapshot([first]),
    }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderSection(connection)
    await screen.findByText('First template')
    fireEvent.click(screen.getByRole('button', { name: `${en.remove}: Second template` }))

    await screen.findByText(en.deleted)
    expect(screen.getByText('First template')).toBeTruthy()
    expect(screen.queryByText('Second template')).toBeNull()
  })

  it('cancels an edit and reports both delete failure forms', async () => {
    let deleteAttempts = 0
    const { connection } = rpcHarness((endpoint) => {
      if (endpoint === 'list') return Promise.resolve({ ok: true, value: snapshot([view()]) })
      deleteAttempts += 1
      return deleteAttempts === 1
        ? { ok: false, error: { code: 'internal', message: 'delete rejected', details: {} } }
        : rejectUnknown('delete transport closed')
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderSection(connection)
    const edit = await screen.findByRole('button', { name: `${en.editTitle}: Insight report` })
    fireEvent.click(edit)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('heading', { name: en.editTitle })).toBeNull()

    fireEvent.click(edit)
    fireEvent.click(screen.getByRole('button', { name: `${en.remove}: Insight report` }))
    await screen.findByText('delete rejected')
    fireEvent.click(screen.getByRole('button', { name: `${en.remove}: Insight report` }))
    await screen.findByText('delete transport closed')
  })

  it('reports a load failure and retries without discarding the localized page', async () => {
    let attempts = 0
    const { connection } = rpcHarness(() => {
      attempts += 1
      return attempts === 1
        ? rejectUnknown('offline')
        : { ok: true, value: snapshot([]) }
    })

    renderSection(connection, zh)
    expect((await screen.findByRole('alert')).textContent).toBe(`${zh.loadFailed}: offline`)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(screen.getByText(zh.empty)).toBeTruthy() })
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
  })

  it('reports a structured RPC load failure', async () => {
    const { connection } = rpcHarness(() => ({
      ok: false,
      error: { code: 'internal', message: 'template service unavailable', details: {} },
    }))

    renderSection(connection)
    expect((await screen.findByRole('alert')).textContent).toBe(`${en.loadFailed}: template service unavailable`)
  })

  it('clears private rows on an authority change and ignores an older authority response', async () => {
    const first = rpcHarness(() => Promise.resolve({ ok: true, value: snapshot([view({ name: 'Server A' })]) }))
    const secondReply = deferred<RpcResponse>()
    const second = rpcHarness(() => secondReply.promise)
    const thirdReply = deferred<RpcResponse>()
    const third = rpcHarness(() => thirdReply.promise)
    const rendered = render(<TaskTemplateSection {...sectionProps(first.connection)} />)
    await screen.findByText('Server A')

    rendered.rerender(<TaskTemplateSection {...sectionProps(second.connection)} />)
    expect(screen.queryByText('Server A')).toBeNull()
    expect(screen.getByText(en.loading)).toBeTruthy()
    rendered.rerender(<TaskTemplateSection {...sectionProps(third.connection)} />)
    await act(async () => {
      secondReply.resolve({ ok: true, value: snapshot([view({ name: 'Server B' })]) })
    })
    expect(screen.queryByText('Server B')).toBeNull()
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => {
      thirdReply.resolve({ ok: true, value: snapshot([view({ name: 'Server C' })]) })
    })
    expect(screen.getByText('Server C')).toBeTruthy()

    const staleErrorReply = deferred<RpcResponse>()
    const staleError = rpcHarness(() => staleErrorReply.promise)
    const final = rpcHarness(() => Promise.resolve({ ok: true, value: snapshot([view({ name: 'Server E' })]) }))
    rendered.rerender(<TaskTemplateSection {...sectionProps(staleError.connection)} />)
    await waitFor(() => { expect(staleError.calls).toHaveLength(1) })
    rendered.rerender(<TaskTemplateSection {...sectionProps(final.connection)} />)
    await screen.findByText('Server E')
    await act(async () => { staleErrorReply.reject(new Error('stale load failure')) })
    expect(screen.queryByText('stale load failure')).toBeNull()
    expect(screen.getByText('Server E')).toBeTruthy()
  })

  it('does not publish a save that settles after the Connection authority changes', async () => {
    const createReply = deferred<RpcResponse>()
    const first = rpcHarness(endpoint => endpoint === 'list'
      ? Promise.resolve({ ok: true, value: snapshot([]) })
      : createReply.promise)
    const second = rpcHarness(() => Promise.resolve({ ok: true, value: snapshot([]) }))
    const rendered = render(<TaskTemplateSection {...sectionProps(first.connection)} />)
    await screen.findByText(en.empty)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fillNewTemplate()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(first.calls.map(call => call.endpoint)).toContain('create') })

    rendered.rerender(<TaskTemplateSection {...sectionProps(second.connection)} />)
    await act(async () => {
      createReply.resolve({ ok: true, value: snapshot([view({ name: 'Old authority result' })]) })
    })
    expect(screen.queryByText('Old authority result')).toBeNull()
    expect(screen.queryByText(en.saved)).toBeNull()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('does not publish a delete that settles after the Connection authority changes', async () => {
    const deleteReply = deferred<RpcResponse>()
    const first = rpcHarness(endpoint => endpoint === 'list'
      ? Promise.resolve({ ok: true, value: snapshot([view()]) })
      : deleteReply.promise)
    const second = rpcHarness(() => Promise.resolve({ ok: true, value: snapshot([]) }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const rendered = render(<TaskTemplateSection {...sectionProps(first.connection)} />)
    await screen.findByText('Insight report')
    fireEvent.click(screen.getByRole('button', { name: `${en.remove}: Insight report` }))

    rendered.rerender(<TaskTemplateSection {...sectionProps(second.connection)} />)
    await act(async () => {
      deleteReply.resolve({ ok: true, value: snapshot([view({ name: 'Old delete result' })]) })
    })
    expect(screen.queryByText('Old delete result')).toBeNull()
    expect(screen.queryByText(en.deleted)).toBeNull()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('ignores a delete failure from an older Connection authority', async () => {
    const deleteReply = deferred<RpcResponse>()
    const first = rpcHarness(endpoint => endpoint === 'list'
      ? Promise.resolve({ ok: true, value: snapshot([view()]) })
      : deleteReply.promise)
    const second = rpcHarness(() => Promise.resolve({ ok: true, value: snapshot([]) }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const rendered = render(<TaskTemplateSection {...sectionProps(first.connection)} />)
    await screen.findByText('Insight report')
    fireEvent.click(screen.getByRole('button', { name: `${en.remove}: Insight report` }))
    await waitFor(() => { expect(first.calls.map(call => call.endpoint)).toContain('delete') })

    rendered.rerender(<TaskTemplateSection {...sectionProps(second.connection)} />)
    await act(async () => { deleteReply.reject(new Error('stale delete failure')) })
    expect(screen.queryByText('stale delete failure')).toBeNull()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })
})
