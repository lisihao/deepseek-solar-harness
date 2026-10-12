/** A plugin's text projection decides what text titles are derived from. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, {
  collectSessionTitleMessages,
  SessionTitleProviderId,
  type SessionTitleProviderRequest,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 60, maxTitleBytes: 80 } as const
const ENVELOPE = '[ENV]{"to":"dog"}\n'
const unwrap = (text: string) => (text.startsWith(ENVELOPE) ? text.slice(ENVELOPE.length) : text)

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionTitleService, CONFIG)
  return ctx
}

function session(ctx: Context, id: string) {
  const created = ctx.sessions.create(SessionId(id))
  created.append('turn/start', { turn: 1 })
  return created
}

function prompt(target: ReturnType<typeof session>, text: string) {
  return target.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('collectSessionTitleMessages projection', () => {
  it('derives eligible text from the projected text and drops a message whose projected text is empty', async () => {
    const ctx = await setup()
    const target = session(ctx, 'pure')
    prompt(target, `${ENVELOPE}Review the plan`)
    prompt(target, ENVELOPE)
    prompt(target, 'Plain message')
    expect(collectSessionTitleMessages(target.events).map(message => message.text))
      .toEqual([`${ENVELOPE}Review the plan`, ENVELOPE, 'Plain message'])
    expect(collectSessionTitleMessages(target.events, undefined, unwrap).map(message => message.text))
      .toEqual(['Review the plan', 'Plain message'])
  })
})

describe('SessionTitleService text projection', () => {
  it('derives the fallback from the projected text, and from the raw text again after the registration is disposed', async () => {
    const ctx = await setup()
    const dispose = ctx.sessionTitle.registerTextProjection(unwrap)
    const first = session(ctx, 'projected')
    prompt(first, `${ENVELOPE}Plan the release notes`)
    await settle()
    expect(ctx.sessionTitle.get(first)?.title).toBe('Plan the release notes')

    await dispose()
    const second = session(ctx, 'raw')
    prompt(second, `${ENVELOPE}Plan the release notes`)
    await settle()
    expect(ctx.sessionTitle.get(second)?.title.startsWith('[ENV]')).toBe(true)
  })

  it('gives no title to a message that has nothing but the envelope', async () => {
    const ctx = await setup()
    ctx.sessionTitle.registerTextProjection(unwrap)
    const target = session(ctx, 'empty')
    prompt(target, ENVELOPE)
    await settle()
    expect(ctx.sessionTitle.get(target)).toBeUndefined()
  })

  it('skips a projection that throws and keeps applying the others', async () => {
    const ctx = await setup()
    ctx.sessionTitle.registerTextProjection(() => { throw new Error('broken') })
    ctx.sessionTitle.registerTextProjection(unwrap)
    const target = session(ctx, 'throwing')
    prompt(target, `${ENVELOPE}Fix the login bug`)
    await settle()
    expect(ctx.sessionTitle.get(target)?.title).toBe('Fix the login bug')
  })

  it('hands a title provider the projected text', async () => {
    const ctx = await setup()
    ctx.sessionTitle.registerTextProjection(unwrap)
    const seen: string[][] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('probe'),
      automatic: 'first-prompt',
      generate: async (request: SessionTitleProviderRequest) => {
        seen.push(request.messages.map(message => message.text))
        return { title: 'From provider', messageSeqs: request.messages.map(message => message.seq) }
      },
    })
    const target = session(ctx, 'provider')
    const event = prompt(target, `${ENVELOPE}Summarize the audit`)
    expect(collectSessionTitleMessages(target.events, event.seq)[0]?.text.startsWith('[ENV]')).toBe(true)
    await ctx.sessionTitle.refresh(target)
    expect(seen.at(-1)).toEqual(['Summarize the audit'])
  })

  it('replaces a built-in title made from the envelope on the next prompt, and leaves user and provider titles alone', async () => {
    const ctx = await setup()
    const stale = session(ctx, 'stale')
    prompt(stale, `${ENVELOPE}Clean the cache`)
    await settle()
    expect(ctx.sessionTitle.get(stale)?.title.startsWith('[ENV]')).toBe(true)

    ctx.sessionTitle.registerTextProjection(unwrap)
    prompt(stale, 'And then the logs')
    await settle()
    expect(ctx.sessionTitle.get(stale)?.title).toBe('Clean the cache')
    expect(ctx.sessionTitle.get(stale)?.source).toEqual({ kind: 'fallback' })
    const events = stale.events.filter(event => event.type === 'session/title').length

    prompt(stale, 'A third one')
    await settle()
    expect(stale.events.filter(event => event.type === 'session/title')).toHaveLength(events)

    const renamed = session(ctx, 'renamed')
    prompt(renamed, `${ENVELOPE}Clean the cache`)
    ctx.sessionTitle.rename(renamed, 'My own title')
    prompt(renamed, 'More')
    await settle()
    expect(ctx.sessionTitle.get(renamed)?.title).toBe('My own title')
  })
})
