/** A kennel message addressed to a member is titled by its body, not by its recipient envelope. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { describe, expect, it } from 'vitest'
import { encodeKennelMessage, kennelTitleText } from '../src/recipient-message.ts'

const RECIPIENT = { gouziId: 'dog', generation: 1, mode: 'standard' } as const
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('kennelTitleText', () => {
  it('returns the body of either envelope and any other text unchanged', () => {
    expect(kennelTitleText(encodeKennelMessage('检查任务', RECIPIENT))).toBe('检查任务')
    expect(kennelTitleText(encodeKennelMessage('[DSH kennel recipient]\nquoted', null))).toBe('[DSH kennel recipient]\nquoted')
    expect(kennelTitleText('plain message')).toBe('plain message')
  })

  it('returns a malformed envelope as written instead of throwing', () => {
    expect(kennelTitleText('[DSH kennel recipient]\n{not json}\nbody')).toBe('[DSH kennel recipient]\n{not json}\nbody')
    expect(kennelTitleText('[DSH kennel recipient]')).toBe('[DSH kennel recipient]')
  })
})

describe('session titles of addressed kennel messages', () => {
  it('derive from the body once the projection is registered, and not before', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 6, fallbackMaxBytes: 80, maxTitleBytes: 120 })
    const send = async (id: string) => {
      const session = ctx.sessions.create(SessionId(id))
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: encodeKennelMessage('请检查任务', RECIPIENT) }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await settle()
      return ctx.sessionTitle.get(session)?.title
    }
    expect(await send('before')).toMatch(/^\[DSH kennel recipient\]/)
    const dispose = ctx.sessionTitle.registerTextProjection(kennelTitleText)
    expect(await send('after')).toBe('请检查任务')
    await dispose()
  })
})
