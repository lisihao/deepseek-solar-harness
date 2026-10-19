import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RlmCommandId, RlmRuntimeSessionId, type RlmChildSpawnPolicyV1,
  type RlmRuntimeCreateRequest, type RlmRuntimeHostBindings } from '@deepseek-ai/dsh-rlm-runtime'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalRlmRuntime } from '../src/index.ts'

const limits = { maxDepth: 3, maxChildren: 4, maxTurns: 12, maxCellMs: 2_000, maxOutputBytes: 65_536 }
const model = { operatorId: 'fixture-only', model: 'scripted-fake' }
const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(policy?: RlmChildSpawnPolicyV1, bindings?: RlmRuntimeHostBindings) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spawn-policy-'))
  roots.push(root)
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  let dispatches = 0
  const host: RlmRuntimeHostBindings = bindings ?? { dispatchChild: (request) => {
    dispatches++
    return Promise.resolve({ nativeSessionId: 'fake-' + request.name, nativeTurnId: String(request.commandId),
      result: Promise.resolve({ status: 'settled', stopReason: 'completed', output: [{ type: 'text', text: request.task }] }),
      interrupt: () => Promise.resolve() })
  } }
  const request: RlmRuntimeCreateRequest = { sessionId: RlmRuntimeSessionId('root'), commandId: RlmCommandId('create'),
    executionId: 'fixture-execution', workspace: root, task: 'Synthetic task', model, limits,
    ...policy === undefined ? {} : { childSpawnPolicy: policy } }
  await service.create(request, host)
  const spawn = (name: string, parentSessionId = request.sessionId) => service.spawn({
    commandId: RlmCommandId(name), parentSessionId, name, task: 'Synthetic child ' + name })
  return { root, ctx, service, request, host, spawn, dispatches: () => dispatches }
}

type State = {
  version: number
  sessions: Array<{
    snapshot: {
      sessionId: string
      parentSessionId?: string
      parentChildId?: string
      depth: number
      limits: Record<string, number>
      childSpawnPolicy?: { version: number; mode: string; maxTotalChildren: number }
      children: Array<{ sessionId: string; rlmChildId: string; parentSessionId: string; depth: number; lifecycle?: string }>
    }
  }>
}

async function validTree(): Promise<State> {
  const f = await fixture({ version: 1, mode: 'recursive', maxTotalChildren: 8 })
  try {
    const child = await f.spawn('first')
    await f.spawn('second')
    await f.spawn('grand', child.sessionId)
  } finally { await f.ctx.root.fiber.dispose() }
  return JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')) as State
}

const corruptions: Array<[string, (state: State) => void]> = [
  ['null child entry', (s) => { Reflect.set(s.sessions[0]!.snapshot.children, 0, null) }],
  ['missing policy', (s) => { delete s.sessions[0]!.snapshot.childSpawnPolicy }],
  ['invalid policy version', (s) => { s.sessions[0]!.snapshot.childSpawnPolicy!.version = 2 }],
  ['invalid policy mode', (s) => { s.sessions[0]!.snapshot.childSpawnPolicy!.mode = 'self-selected' }],
  ['duplicate session identity', (s) => { s.sessions.push(structuredClone(s.sessions[1]!)) }],
  ['duplicate child reference', (s) => { s.sessions[0]!.snapshot.children.push(structuredClone(s.sessions[0]!.snapshot.children[0]!)) }],
  ['missing deleted child session', (s) => { s.sessions[0]!.snapshot.children[1]!.lifecycle = 'deleted'; s.sessions.splice(2, 1) }],
  ['orphan child session', (s) => { s.sessions[0]!.snapshot.children.shift() }],
  ['wrong depth', (s) => { s.sessions[1]!.snapshot.depth = 2 }],
  ['cycle', (s) => { s.sessions[0]!.snapshot.parentSessionId = s.sessions[1]!.snapshot.sessionId }],
  ['child policy drift', (s) => { s.sessions[1]!.snapshot.childSpawnPolicy!.maxTotalChildren = 9 }],
  ['child limits loosened', (s) => { s.sessions[1]!.snapshot.limits.maxDepth = 4 }],
  ['none with accepted descendants', (s) => { for (const row of s.sessions) row.snapshot.childSpawnPolicy = {
    version: 1, mode: 'none', maxTotalChildren: 0 } }],
  ['root-only with a grandchild', (s) => { for (const row of s.sessions) row.snapshot.childSpawnPolicy!.mode = 'root-only' }],
  ['cumulative limit exceeded', (s) => { for (const row of s.sessions) row.snapshot.childSpawnPolicy!.maxTotalChildren = 2 }],
  ['depth limit exceeded', (s) => { for (const row of s.sessions) row.snapshot.limits.maxDepth = 1 }],
  ['live parent limit exceeded', (s) => { for (const row of s.sessions) row.snapshot.limits.maxChildren = 1 }],
  ['empty child identity', (s) => { s.sessions[0]!.snapshot.children[0]!.rlmChildId = ''; s.sessions[1]!.snapshot.parentChildId = '' }],
]

describe('actual Host child-spawn policy', () => {
  it('resolves the existing default and refuses none before dispatch', async () => {
    const legacy = await fixture()
    try { expect((await legacy.service.inspect(legacy.request.sessionId)).childSpawnPolicy)
      .toEqual({ version: 1, mode: 'recursive', maxTotalChildren: limits.maxTurns })
    } finally { await legacy.ctx.root.fiber.dispose() }
    const none = await fixture({ version: 1, mode: 'none', maxTotalChildren: 0 })
    try {
      await expect(none.spawn('denied')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(none.dispatches()).toBe(0)
      expect(await none.service.listChildren(none.request.sessionId)).toEqual([])
    } finally { await none.ctx.root.fiber.dispose() }
  })

  it('allows only roots under root-only and recursive grandchildren share one cumulative cap', async () => {
    const flat = await fixture({ version: 1, mode: 'root-only', maxTotalChildren: 3 })
    try {
      const child = await flat.spawn('child')
      await expect(flat.spawn('grand', child.sessionId)).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(flat.dispatches()).toBe(1)
      expect((await flat.service.inspect(child.sessionId)).childSpawnPolicy).toEqual(flat.request.childSpawnPolicy)
    } finally { await flat.ctx.root.fiber.dispose() }
    const recursive = await fixture({ version: 1, mode: 'recursive', maxTotalChildren: 2 })
    try {
      const child = await recursive.spawn('child')
      await recursive.spawn('grand', child.sessionId)
      await expect(recursive.spawn('third')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(recursive.dispatches()).toBe(2)
    } finally { await recursive.ctx.root.fiber.dispose() }
  })

  it('does not refund a deleted accepted child or replay the same command', async () => {
    const f = await fixture({ version: 1, mode: 'recursive', maxTotalChildren: 1 })
    try {
      const child = await f.spawn('child')
      expect(await f.spawn('child')).toEqual(child)
      await f.service.deleteChild(f.request.sessionId, child.rlmChildId, RlmCommandId('delete'))
      await expect(f.spawn('replacement')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(f.dispatches()).toBe(1)
    } finally { await f.ctx.root.fiber.dispose() }
  })

  it('commits the final cumulative slot before dispatch yields to another spawn', async () => {
    let release!: () => void
    let dispatches = 0
    const held = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture({ version: 1, mode: 'recursive', maxTotalChildren: 1 }, { dispatchChild: async () => {
      dispatches++
      await held
      return { nativeSessionId: 'fake', nativeTurnId: 'fake', result: Promise.resolve({ status: 'settled' }),
        interrupt: () => Promise.resolve() }
    } })
    try {
      const first = f.spawn('first')
      await expect(f.spawn('second')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      release()
      await first
      expect(dispatches).toBe(1)
    } finally { release(); await f.ctx.root.fiber.dispose() }
  })

  it('does not refund dispatch failure and refuses a different reopen policy before replacing bindings', async () => {
    let dispatches = 0
    const f = await fixture({ version: 1, mode: 'recursive', maxTotalChildren: 1 }, { dispatchChild: () => {
      dispatches++; throw new Error('fake dispatch failed')
    } })
    try {
      await expect(f.spawn('failed')).rejects.toThrow('fake dispatch failed')
      await expect(f.spawn('replacement')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(() => f.service.create({ ...f.request, commandId: RlmCommandId('reopen'),
        childSpawnPolicy: { version: 1, mode: 'recursive', maxTotalChildren: 2 } }, f.host)).toThrow('policy conflicts')
      expect(dispatches).toBe(1)
    } finally { await f.ctx.root.fiber.dispose() }
  })

  it('retains policy and accepted slots after restart without dispatch replay', async () => {
    const f = await fixture({ version: 1, mode: 'root-only', maxTotalChildren: 1 }, { dispatchChild: () => Promise.resolve({
      nativeSessionId: 'fake-pending', nativeTurnId: 'fake-pending', result: new Promise(() => {}), interrupt: () => Promise.resolve(),
    }) })
    await f.spawn('pending')
    await f.ctx.root.fiber.dispose()
    const ctx = new Context()
    const recovered = new LocalRlmRuntime(ctx, f.root)
    try {
      await recovered.bindHost(f.request.sessionId, f.host)
      expect((await recovered.inspect(f.request.sessionId)).childSpawnPolicy).toEqual(f.request.childSpawnPolicy)
      await expect(recovered.spawn({ commandId: RlmCommandId('after-restart'), parentSessionId: f.request.sessionId,
        name: 'after-restart', task: 'Synthetic child' })).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect((await recovered.listChildren(f.request.sessionId))[0]?.lifecycle).toBe('indeterminate')
    } finally { await ctx.root.fiber.dispose() }
  })

  it.each(corruptions)('rejects durable %s before recovery writes', async (_name, corrupt) => {
    const state = await validTree()
    corrupt(state)
    const root = await mkdtemp(join(tmpdir(), 'dsh-spawn-invalid-'))
    roots.push(root)
    const bytes = JSON.stringify(state) + '\n'
    await writeFile(join(root, 'state.json'), bytes)
    const ctx = new Context()
    try {
      expect(() => new LocalRlmRuntime(ctx, root)).toThrow('unsupported child-spawn state')
      expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(bytes)
    } finally { await ctx.root.fiber.dispose() }
  })
})
