import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

describe('Desktop session compatibility patch', () => {
  it('preserves an ignorable marker supplied by a log-only plugin event', () => {
    const session = Session.create(SessionId('desktop-ignorable-event'))

    const event = session.append('turn/start', { turn: 1 }, { ignorable: true })

    expect(event).toMatchObject({
      type: 'turn/start',
      data: { turn: 1 },
      ignorable: true,
    })
    expect(session.events[0]?.ignorable).toBe(true)
  })
})
