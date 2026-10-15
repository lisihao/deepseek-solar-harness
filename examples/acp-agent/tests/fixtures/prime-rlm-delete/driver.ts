#!/usr/bin/env node
/** Emit a keyless transcript of a permanent RLM delete through the production app boot and YAML Loader. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import {
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmChildExecution,
  type RlmChildExecutionResult,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'

const configPath = process.argv[2]
if (configPath === undefined || process.env.DSH_HOME === undefined) {
  throw new Error('prime-rlm-delete fixture requires a config path and an isolated DSH_HOME')
}
const ctx = await boot('prime-rlm-delete-keyless-example', resolveConfigPath(configPath, undefined))
try {
  const runtime = ctx.get('rlmRuntime')
  if (runtime === undefined) throw new Error('Loader did not mount rlmRuntime')
  const names = new Map<string, string>()
  const calls: string[] = []
  const nameOf = (sessionId: string): string => names.get(sessionId) ?? 'root'
  // `a1` keeps running after its interrupt request, as a Resident turn that has not stopped yet does.
  const execution = (name: string, turn: string): RlmChildExecution => ({
    nativeSessionId: `keyless-${name}`,
    nativeTurnId: turn,
    result: name === 'a1' ? new Promise<RlmChildExecutionResult>(() => undefined) : Promise.resolve({ status: 'settled' }),
    interrupt: () => { calls.push(`interrupt ${name}`); return Promise.resolve() },
  })
  const bindings: RlmRuntimeHostBindings = {
    dispatchChild(request) {
      calls.push(`dispatch child ${request.name}`)
      return Promise.resolve(execution(request.name, `turn-${request.name}`))
    },
    dispatchContinuation(request) {
      calls.push(`dispatch continuation for ${nameOf(String(request.sessionId))}`)
      return Promise.resolve(execution(`continuation-${nameOf(String(request.sessionId))}`, String(request.commandId)))
    },
  }
  const sessionId = RlmRuntimeSessionId('delete-loader-root')
  await runtime.create({
    sessionId,
    commandId: RlmCommandId('delete-loader-create'),
    executionId: 'delete-loader-execution',
    workspace: process.cwd(),
    task: 'Delete a child that has a running descendant and a queued message.',
    model: { operatorId: 'codex', model: 'gpt-5.6-sol' },
    limits: { maxDepth: 3, maxChildren: 3, maxTurns: 8, maxCellMs: 2_000, maxOutputBytes: 16 * 1024 },
  }, bindings)
  const spawn = async (parent: RlmRuntimeSessionId, name: string) => {
    const handle = await runtime.spawn({ commandId: RlmCommandId(`delete-loader-${name}`), parentSessionId: parent, name, task: `child ${name}` })
    names.set(String(handle.sessionId), name)
    return handle
  }
  const a = await spawn(sessionId, 'a')
  const b = await spawn(sessionId, 'b')
  const a1 = await spawn(a.sessionId, 'a1')
  const send = (id: string, from: RlmRuntimeSessionId, to: RlmRuntimeSessionId) => runtime.sendMessage({
    commandId: RlmCommandId(id), fromSessionId: from, toSessionId: to, mode: 'follow_up', text: id,
  })
  const heartbeat = await runtime.createHeartbeat({
    sessionId: a1.sessionId, commandId: RlmCommandId('delete-loader-heartbeat'), instruction: 'check progress', interval: '1s',
  })
  await send('delete-loader-queued', a.sessionId, a1.sessionId)
  calls.push('-- delete a')
  await runtime.deleteChild(sessionId, a.rlmChildId, RlmCommandId('delete-loader-delete'))

  // Everything that used to wake the deleted subtree up again.
  await runtime.pumpMessages()
  const heartbeatsAdmitted = await runtime.pumpHeartbeats(new Date(Date.parse(heartbeat.nextRunAt ?? '') + 1).toISOString())
  const refusal = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action()
      return 'accepted'
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
      return `${code}: ${(error as Error).message.replace(/rlm-session-[0-9a-f-]+/gu, '<session>')}`
    }
  }
  const refusals = {
    spawnUnderDeleted: await refusal(() => spawn(a1.sessionId, 'late')),
    messageToDeleted: await refusal(() => send('delete-loader-late', a.sessionId, a1.sessionId)),
    cellInDeleted: await refusal(() => runtime.executeCell({ sessionId: a1.sessionId, commandId: RlmCommandId('delete-loader-cell'), code: '1 + 1' })),
    drainWhileStopping: await refusal(() => runtime.drain(sessionId, 50)),
  }
  // The root and the sibling keep working.
  await send('delete-loader-sibling', sessionId, b.sessionId)
  const lifecycles = async (parent: RlmRuntimeSessionId) => (await runtime.listChildren(parent)).map(child => `${child.name}: ${child.lifecycle}`)
  process.stdout.write(`${JSON.stringify({
    calls, heartbeatsAdmitted, refusals,
    children: { root: await lifecycles(sessionId), a: await lifecycles(a.sessionId) },
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
