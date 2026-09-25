import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as WebInvariant from '../src/invariant.ts'
import type {} from '../src/web-session.ts'

interface Identity {
  commandId: string
  parentId: string
  laneId: string
  laneKey: string
}

const identity: Identity = {
  commandId: 'command-1',
  parentId: 'parent-1',
  laneId: 'main',
  laneKey: 'parent-1:main',
}

async function mount(install = true): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('chatgpt-web-invariant'))
  await ctx.plugin(InvariantRegistry, { enabled: true })
  if (install) await ctx.plugin(WebInvariant)
  return { ctx, session }
}

function appendIntent(session: Session, overrides: Partial<Identity> = {}): void {
  session.append('chatgpt-web/intent', {
    ...identity,
    ...overrides,
    workspaceName: 'dsh-web-main',
    promptSha256: 'prompt-hash',
    targetUrl: 'https://chatgpt.com/',
    connectorName: 'DSH',
    baselineUserMessageIds: [],
  }, { ignorable: true })
}

function appendAccepted(
  session: Session,
  overrides: Partial<Identity> & Partial<{
    workspaceName: string
    connectorName: string
    conversationId: string
    conversationUrl: string
    userMessageId: string
  }> = {},
): void {
  session.append('chatgpt-web/accepted', {
    ...identity,
    workspaceName: 'dsh-web-main',
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    userMessageId: 'user-1',
    connectorName: 'DSH',
    ...overrides,
    requestIds: ['request-1'],
  }, { ignorable: true })
}

function appendCompleted(
  session: Session,
  overrides: Partial<Identity> & Partial<{
    conversationId: string
    conversationUrl: string
    userMessageId: string
    assistantMessageId: string
  }> = {},
): void {
  session.append('chatgpt-web/completed', {
    ...identity,
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    ...overrides,
    response: 'completed response',
    responseSha256: 'response-hash',
    truncated: false,
    model: 'fixture-model',
    requestIds: ['request-1'],
  }, { ignorable: true })
}

function expectInvariant(action: () => void): void {
  expect(action).toThrow(expect.objectContaining<Partial<InvariantError>>({
    code: 'INVARIANT',
    packageName: '@deepseek-ai/dsh-physical-operator-chatgpt-web',
  }))
}

describe('ChatGPT Web receipt invariants', () => {
  it('accepts an intent, exact accepted native turn, and matching completion', async () => {
    const { session } = await mount()

    expect(() => {
      appendIntent(session)
      appendAccepted(session)
      appendCompleted(session)
    }).not.toThrow()
  })

  it('rejects an accepted receipt without a prior intent', async () => {
    const { session } = await mount()

    expectInvariant(() => { appendAccepted(session) })
  })

  it('rejects a completion without a prior accepted native turn', async () => {
    const { session } = await mount()
    appendIntent(session)

    expectInvariant(() => { appendCompleted(session) })
  })

  it('rejects a command whose accepted receipt changes its lane identity', async () => {
    const { session } = await mount()
    appendIntent(session)

    expectInvariant(() => {
      appendAccepted(session, { laneId: 'other', laneKey: 'parent-1:other' })
    })
  })

  it('rejects completion for a different native user turn', async () => {
    const { session } = await mount()
    appendIntent(session)
    appendAccepted(session)

    expectInvariant(() => { appendCompleted(session, { userMessageId: 'user-other' }) })
  })

  it('validates a persisted receipt prefix on restart without requiring a resend', async () => {
    const { ctx, session } = await mount(false)
    appendIntent(session)
    appendAccepted(session)
    appendCompleted(session)

    await expect(ctx.plugin(WebInvariant)).resolves.toBeDefined()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })

  it('rejects an invalid persisted receipt prefix while loading the companion', async () => {
    const { ctx, session } = await mount(false)
    appendAccepted(session)

    await expect(ctx.plugin(WebInvariant)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-physical-operator-chatgpt-web',
    })
  })
})
