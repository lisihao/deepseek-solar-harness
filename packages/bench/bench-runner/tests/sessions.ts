/**
 * Builds real JSONL session logs through the shipping persistence backend,
 * for the fake launcher to copy into a run home.
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

type Draft = Omit<SessionEvent, 'seq'>

/** A root turn with two parallel tool calls (one failing), a retry, and a priced reply. */
export function rootEvents(): Draft[] {
  return [
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'step/start', time: 1000, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', time: 1400, data: {
        turn: 1, step: 1,
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'calling' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
      },
    },
    { type: 'tool/call', time: 1400, data: { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{}' } },
    { type: 'tool/call', time: 1400, data: { turn: 1, step: 1, callId: 'b', name: 'read', arguments: '{}' } },
    { type: 'tool/result', time: 1500, data: { turn: 1, step: 1, message: toolResult('a', false) } },
    { type: 'tool/result', time: 1700, data: { turn: 1, step: 1, message: toolResult('b', true), error: { name: 'Error', code: 'E' } } },
    { type: 'step/end', time: 1700, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as Draft[]
}

function toolResult(callId: string, isError: boolean): unknown {
  return {
    id: `r-${callId}`, role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], ...isError ? { isError: true } : {} }],
    source: { kind: 'tool', callId },
  }
}

/** A subagent reply that costs tokens. */
export function childEvents(): Draft[] {
  return [
    { type: 'turn/start', time: 1100, data: { turn: 1 } },
    {
      type: 'assistant/message', time: 1200, data: {
        turn: 1, step: 1,
        message: { id: 'c1', role: 'assistant', content: [{ type: 'text', text: 'child' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    },
  ] as Draft[]
}

/**
 * Persist sessions under `root` the way a dsh run does.
 * @param root - the `sessions` directory to write.
 * @param sessions - header overrides and events per session.
 */
export async function writeSessions(
  root: string,
  sessions: readonly { id: string; header?: Partial<SessionHeader>; events: Draft[] }[],
): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root })
  for (const session of sessions) {
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(session.id), createdAt: 1, cwd: '/work', ...session.header }
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(meta.id, session.events.map((event, seq) => ({ ...event, seq }) as SessionEvent))
  }
  await ctx.fiber.dispose()
}
