import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import { describe, expect, it } from 'vitest'
import { LocalRlmRuntime } from '../src/index.ts'

const limits = { maxDepth: 3, maxChildren: 4, maxTurns: 12, maxCellMs: 2_000, maxOutputBytes: 64 * 1024 } as const
const model = { operatorId: 'codex', model: 'gpt-5.6-luna' } as const
const ROOT_SECRET = 'ROOT-ONLY-SECRET-5521'
const CHILD_TAIL = 'Final rule: end with the token CHILD-TAIL-RULE.'
const CHILD_TASK = `Child task. ${'Detail line of the child task. '.repeat(120)}${CHILD_TAIL}`

const bindings: RlmRuntimeHostBindings = {
  dispatchChild: request => Promise.resolve({
    nativeSessionId: `child:${request.childSessionId}`, nativeTurnId: `turn:${request.childId}`,
    result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
  }),
}

async function rootWith(context: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-child-context-'))
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  const sessionId = RlmRuntimeSessionId('rlm-session-root')
  await service.create({
    sessionId, commandId: RlmCommandId('create-root'), executionId: 'execution-root', workspace: root,
    task: 'solve a bounded task', model, limits, context: context as never,
  }, bindings)
  return { root, ctx, service, sessionId }
}

async function contextOf(service: LocalRlmRuntime, sessionId: RlmRuntimeSessionId, id: string): Promise<Record<string, unknown>> {
  const result = await service.executeCell({ sessionId, commandId: RlmCommandId(id), code: 'JSON.parse(JSON.stringify(context))' })
  return result.value as Record<string, unknown>
}

const protocol = {
  runId: 'run-1', nodeId: 'node-1', contextPacketRef: 'sha256:packet', capabilityPlanRef: 'sha256:plan',
  graphCertificateHash: 'cert', defaultChildOperatorId: 'codex', defaultChildModel: 'gpt-5.6-luna', defaultChildTier: 'low',
}

describe('what a child\'s REPL context starts with', () => {
  it('holds the protocol keys of its parent and its own whole task, and none of the parent\'s task or stored values', async () => {
    const t = await rootWith({ ...protocol, task: `Root task. Private: ${ROOT_SECRET}. Final rule: root.`, objective: 'parent objective' })
    await t.service.executeCell({ sessionId: t.sessionId, commandId: RlmCommandId('stash'), code: 'context.stash = "stored by the root\'s cell"; 1' })
    const child = await t.service.spawn({ commandId: RlmCommandId('child'), parentSessionId: t.sessionId, name: 'child', task: CHILD_TASK })
    const seen = await contextOf(t.service, child.sessionId, 'read-child')
    expect(seen).toEqual({ ...protocol, task: CHILD_TASK })
    expect(JSON.stringify(seen)).not.toContain(ROOT_SECRET)
    expect(JSON.stringify(seen)).not.toContain('stored by the root')
    expect(seen).not.toHaveProperty('objective')
    expect((seen.task as string).endsWith(CHILD_TAIL)).toBe(true)
    // The root keeps its own context whole.
    const own = await contextOf(t.service, t.sessionId, 'read-root')
    expect(own.task).toContain(ROOT_SECRET)
    expect(own.stash).toBe('stored by the root\'s cell')
    // The child's task as the runtime holds it is the same whole task.
    await expect(t.service.inspect(child.sessionId)).resolves.toMatchObject({ task: CHILD_TASK })
    await t.ctx.root.fiber.dispose()
  })

  it('gives a grandchild its parent\'s protocol keys and its own task, not the child\'s task', async () => {
    const t = await rootWith({ ...protocol, task: `Root task ${ROOT_SECRET}` })
    const child = await t.service.spawn({ commandId: RlmCommandId('child'), parentSessionId: t.sessionId, name: 'child', task: CHILD_TASK })
    const grand = await t.service.spawn({ commandId: RlmCommandId('grand'), parentSessionId: child.sessionId, name: 'grand', task: 'Grandchild task.' })
    expect(await contextOf(t.service, grand.sessionId, 'read-grand')).toEqual({ ...protocol, task: 'Grandchild task.' })
    await t.ctx.root.fiber.dispose()
  })

  it('has only its own task when the parent has no protocol keys', async () => {
    const t = await rootWith({ objective: 'test', task: `Root ${ROOT_SECRET}` })
    const child = await t.service.spawn({ commandId: RlmCommandId('child'), parentSessionId: t.sessionId, name: 'child', task: 'Only task.' })
    expect(await contextOf(t.service, child.sessionId, 'read-child')).toEqual({ task: 'Only task.' })
    await t.ctx.root.fiber.dispose()
  })

  it('is the same after a restart, with the same task and protocol keys', async () => {
    const t = await rootWith({ ...protocol, task: `Root ${ROOT_SECRET}` })
    const child = await t.service.spawn({ commandId: RlmCommandId('child'), parentSessionId: t.sessionId, name: 'child', task: CHILD_TASK })
    const before = await contextOf(t.service, child.sessionId, 'before')
    await t.ctx.root.fiber.dispose()
    const context = new Context()
    const recovered = new LocalRlmRuntime(context, t.root)
    await recovered.bindHost(t.sessionId, bindings)
    await recovered.bindHost(child.sessionId, bindings)
    expect(await contextOf(recovered, child.sessionId, 'after')).toEqual(before)
    await expect(recovered.inspect(child.sessionId)).resolves.toMatchObject({ task: CHILD_TASK })
    await context.root.fiber.dispose()
  })

  it('leaves a session persisted with the old cloned context as it is, on load and on later writes', async () => {
    const t = await rootWith({ ...protocol, task: `Root task ${ROOT_SECRET}` })
    const old = await t.service.spawn({ commandId: RlmCommandId('old-child'), parentSessionId: t.sessionId, name: 'old', task: 'Old child task.' })
    await t.ctx.root.fiber.dispose()
    // Write the state as an earlier build would have: the child's context is a clone of the root's.
    const file = join(t.root, 'state.json')
    const state = JSON.parse(await readFile(file, 'utf8')) as { sessions: Array<{ snapshot: { sessionId: string }; context: unknown }> }
    const rootSession = state.sessions.find(session => session.snapshot.sessionId === 'rlm-session-root')
    const oldSession = state.sessions.find(session => session.snapshot.sessionId === String(old.sessionId))
    if (rootSession === undefined || oldSession === undefined) throw new Error('fixture sessions are missing')
    oldSession.context = structuredClone(rootSession.context)
    await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const written = await readFile(file, 'utf8')

    // Loading changes nothing.
    const loadedContext = new Context()
    const loaded = new LocalRlmRuntime(loadedContext, t.root)
    expect(await readFile(file, 'utf8')).toBe(written)
    await loaded.bindHost(t.sessionId, bindings)
    await loaded.bindHost(old.sessionId, bindings)
    // The old child still shows what it was persisted with, and a later write does not rewrite it.
    expect(JSON.stringify(await contextOf(loaded, old.sessionId, 'read-old'))).toContain(ROOT_SECRET)
    const fresh = await loaded.spawn({ commandId: RlmCommandId('new-child'), parentSessionId: t.sessionId, name: 'fresh', task: 'Fresh task.' })
    const after = JSON.parse(await readFile(file, 'utf8')) as typeof state
    expect(after.sessions.find(session => session.snapshot.sessionId === String(old.sessionId))?.context).toEqual(oldSession.context)
    expect(after.sessions.find(session => session.snapshot.sessionId === String(fresh.sessionId))?.context).toEqual({ ...protocol, task: 'Fresh task.' })
    await loadedContext.root.fiber.dispose()
  })
})
