// The cell results below are untyped JSON from the helper under test; each assertion states the shape it expects.
// oxlint-disable typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-explicit-any
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/restrict-plus-operands
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  RlmCommandId,
  RlmRuntimeError,
  RlmRuntimeSessionId,
  type RlmChildResultContentV1,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import { describe, expect, it } from 'vitest'
import { LocalRlmRuntime } from '../src/index.ts'

const model = { operatorId: 'codex', model: 'gpt-5.6-luna' } as const
const limitsOf = (maxOutputBytes: number) => ({ maxDepth: 3, maxChildren: 5, maxTurns: 20, maxCellMs: 2_000, maxOutputBytes }) as const
const ref = (name: string): string => `sha256:${createHash('sha256').update(name).digest('hex')}`

// Mixed content so that segment boundaries meet multi-byte characters and surrogate pairs.
const LONG = `${'alpha 😀 beta — gamma 漢字 delta. '.repeat(40)}LAST-LINE-RULE`
const content = (text: string): RlmChildResultContentV1 => ({
  kind: 'prime-rlm-child-result', commandId: 'exec-1', stopReason: 'completed', output: [{ type: 'text', text }],
})

interface Behavior {
  readonly status: 'settled' | 'failed' | 'indeterminate' | 'running'
  readonly stored?: RlmChildResultContentV1
  readonly hasRef?: boolean
}

/** Roots with children whose outcomes are chosen by name; `reads` records every request the Provider made of the host. */
interface SetupOptions {
  readonly behaviors?: Record<string, Behavior>
  readonly maxOutputBytes?: number
  readonly noReader?: boolean
  /** The reader refuses with this message, as the daemon does for a damaged stored result. */
  readonly readerError?: string
}

async function setup(options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-child-result-'))
  const behaviors: Record<string, Behavior> = options.behaviors ?? {}
  const store = new Map<string, RlmChildResultContentV1>()
  const reads: Array<{ sessionId: string; childSessionId: string; resultRef: string }> = []
  const bindings: RlmRuntimeHostBindings = {
    dispatchChild: (request) => {
      const behavior = behaviors[request.name] ?? { status: 'settled', stored: content(LONG), hasRef: true }
      const resultRef = ref(`result:${request.name}`)
      if (behavior.stored !== undefined) store.set(resultRef, behavior.stored)
      const result = behavior.status === 'running'
        ? new Promise<never>(() => undefined)
        : Promise.resolve({
          status: behavior.status,
          ...behavior.status === 'failed' ? { error: 'boom', stopReason: 'error' as const } : {},
          ...behavior.status === 'indeterminate' ? { error: 'lost' } : {},
          ...behavior.hasRef === false ? {} : { resultRef },
          outputPreview: `preview of ${request.name} ${'x'.repeat(300)}`,
        })
      return Promise.resolve({
        nativeSessionId: `n:${request.childSessionId}`, nativeTurnId: `t:${request.childId}`, result, interrupt: () => Promise.resolve(),
      })
    },
    ...options.noReader === true ? {} : {
      readResult: (request) => {
        if (options.readerError !== undefined) return Promise.reject(new RlmRuntimeError(options.readerError, 'RLM_UNAVAILABLE'))
        reads.push({ sessionId: String(request.sessionId), childSessionId: String(request.childSessionId), resultRef: request.resultRef })
        return Promise.resolve(store.get(request.resultRef))
      },
    },
  }
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  const create = async (name: string) => {
    const sessionId = RlmRuntimeSessionId(`rlm-session-${name}`)
    await service.create({
      sessionId, commandId: RlmCommandId(`create-${name}`), executionId: `execution-${name}`, workspace: root, task: 'solve',
      model, limits: limitsOf(options.maxOutputBytes ?? 64 * 1024), context: {},
    }, bindings)
    return sessionId
  }
  const root1 = await create('root1')
  const spawn = (parent: RlmRuntimeSessionId, name: string) => service.spawn({
    commandId: RlmCommandId(`spawn-${String(parent)}-${name}`), parentSessionId: parent, name, task: `task of ${name}`,
  })
  const settledTree = async () => {
    const a = await spawn(root1, 'a')
    const b = await spawn(root1, 'b')
    const a1 = await spawn(a.sessionId, 'a1')
    const root2 = await create('root2')
    const c = await spawn(root2, 'c')
    await new Promise(resolve => setTimeout(resolve, 60))
    return { a, b, a1, c, root2 }
  }
  let counter = 0
  /** Run `code` in a session and return its value; a thrown error comes back as `{ error: { code, message } }`. */
  const run = async (sessionId: RlmRuntimeSessionId, code: string): Promise<any> => {
    counter += 1
    const wrapped = `try { return (${code}) } catch (error) { return ({ error: { code: error.code, message: error.message } }) }`
    return (await service.executeCell({ sessionId, commandId: RlmCommandId(`cell-${String(counter)}`), code: `(async () => { ${wrapped} })()` })).value
  }
  return { root, ctx, service, root1, create, spawn, settledTree, run, reads, store, bindings }
}

describe('a root that creates no child', () => {
  it('finishes with no child, no child record, and nothing to read, and is idle for drain', async () => {
    const t = await setup()
    expect(await t.run(t.root1, '({ answer: 6 * 7 })')).toEqual({ answer: 42 })
    expect(await t.run(t.root1, 'await rlm.listSubagents()')).toEqual([])
    expect(await t.run(t.root1, 'await rlm.childSummaries()')).toEqual([])
    expect((await t.run(t.root1, 'await rlm.readChildResult("rlm-child-none")')).error.code).toBe('RLM_FAMILY_VIOLATION')
    await expect(t.service.drain(t.root1, 500)).resolves.toMatchObject({ activeExecutions: 0, queuedMessages: 0 })
    const events = (JSON.parse(await readFile(join(t.root, 'state.json'), 'utf8')) as { events: Array<{ type: string }> }).events
    expect(events.filter(event => event.type.startsWith('rlm.child.')).map(event => event.type)).toEqual([])
    await t.ctx.root.fiber.dispose()
  })
})

describe('reading the result of a direct child', () => {
  it('returns segments that put back together into the whole result, with the hash of the segment and of the whole', async () => {
    const t = await setup()
    const { a } = await t.settledTree()
    const parts: string[] = []
    let offset: number | null = 0
    let fullSha: string | undefined
    let first: any
    while (offset !== null) {
      const segment: any = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { offset: ${String(offset)}, limit: 173 })`)
      first ??= segment
      expect(segment).toMatchObject({ status: 'settled', unit: 'utf16-code-units', isData: true, kind: 'prime-rlm-child-result', commandId: 'exec-1' })
      expect(segment.resultRef).toBe(ref('result:a'))
      expect(segment.segmentSha256).toBe(createHash('sha256').update(segment.text, 'utf8').digest('hex'))
      // No segment ends or starts inside a surrogate pair: each is well-formed text.
      expect(segment.text).toBe(Buffer.from(segment.text, 'utf8').toString('utf8'))
      expect(segment.length).toBe(segment.text.length)
      expect(segment.complete).toBe(false)
      fullSha ??= segment.fullSha256
      expect(segment.fullSha256).toBe(fullSha)
      parts.push(segment.text)
      offset = segment.nextOffset
      expect(segment.truncated).toBe(offset !== null)
    }
    expect(parts.join('')).toBe(LONG)
    expect(createHash('sha256').update(parts.join(''), 'utf8').digest('hex')).toBe(fullSha)
    expect(first.totalUnits).toBe(LONG.length)
    // A segment's hash is not the hash of the whole result, and neither is the stored artifact's reference.
    expect(first.segmentSha256).not.toBe(first.fullSha256)
    expect(first.resultRef).not.toContain(first.fullSha256)
    await t.ctx.root.fiber.dispose()
  })

  it('returns the whole result in one segment, marked complete, when it fits', async () => {
    const t = await setup({ behaviors: { a: { status: 'settled', stored: content('short result'), hasRef: true } } })
    const { a } = await t.settledTree()
    const segment = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a)})`)
    expect(segment).toMatchObject({ complete: true, truncated: false, nextOffset: null, text: 'short result', length: 12, totalUnits: 12, offset: 0 })
    expect(segment.segmentSha256).toBe(segment.fullSha256)
    await t.ctx.root.fiber.dispose()
  })

  it('renders the text blocks of a result joined by one newline and counts, without rendering, the blocks that are not text', async () => {
    const mixed: RlmChildResultContentV1 = {
      kind: 'prime-rlm-child-result', commandId: 'exec-1', stopReason: 'completed',
      output: [{ type: 'text', text: 'first' }, { type: 'reasoning', text: 'private thoughts' }, { type: 'text', text: 'second' }],
    }
    const t = await setup({ behaviors: { a: { status: 'settled', stored: mixed, hasRef: true } } })
    const { a } = await t.settledTree()
    const segment = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a)})`)
    expect(segment).toMatchObject({ text: 'first\nsecond', totalUnits: 12, omittedBlocks: 1, complete: true })
    expect(JSON.stringify(segment)).not.toContain('private thoughts')
    expect(segment.fullSha256).toBe(createHash('sha256').update('first\nsecond', 'utf8').digest('hex'))
    await t.ctx.root.fiber.dispose()
  })

  it('keeps the whole object it returns to a third of the output limit of the reading session, and always moves forward', async () => {
    const t = await setup({ maxOutputBytes: 4_200 })
    const { a } = await t.settledTree()
    let offset: number | null = 0
    let joined = ''
    while (offset !== null) {
      const segment: any = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { offset: ${String(offset)} })`)
      expect(Buffer.byteLength(JSON.stringify(segment), 'utf8')).toBeLessThanOrEqual(1_400)
      expect(segment.length).toBeGreaterThan(0)
      joined += segment.text
      offset = segment.nextOffset
    }
    expect(joined).toBe(LONG)
    await t.ctx.root.fiber.dispose()
  })

  it('serves text full of quotes and newlines under the same limit, which counts the cell\'s value and its rendering', async () => {
    const heavy = 'line "one"\n\tline \'two\'\n'.repeat(120)
    const t = await setup({ maxOutputBytes: 4_200, behaviors: { a: { status: 'settled', stored: content(heavy), hasRef: true } } })
    const { a } = await t.settledTree()
    let offset: number | null = 0
    let joined = ''
    while (offset !== null) {
      const segment: any = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { offset: ${String(offset)} })`)
      joined += segment.text
      offset = segment.nextOffset
    }
    expect(joined).toBe(heavy)
    await t.ctx.root.fiber.dispose()
  })

  it('refuses everyone but the direct parent, whatever they know about the child or its result', async () => {
    const t = await setup()
    const { a, b, a1, c, root2 } = await t.settledTree()
    const readA = `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)})`
    // A sibling, the child's own child, a different root, and a bare reference with a known hash are all refused.
    expect((await t.run(b.sessionId, readA)).error.code).toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(a1.sessionId, readA)).error.code).toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(root2, readA)).error.code).toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(root2, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { resultRef: ${JSON.stringify(ref('result:a'))} })`)).error.code)
      .toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(t.root1, `await rlm.readChildResult("rlm-child-unknown", { resultRef: ${JSON.stringify(ref('result:a'))} })`)).error.code)
      .toBe('RLM_FAMILY_VIOLATION')
    // A grandchild's result is not readable by the root, only by its own parent; and a child's parent cannot be read from below.
    expect((await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a1.rlmChildId)})`)).error.code).toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(a.sessionId, `await rlm.readChildResult(${JSON.stringify(a1.rlmChildId)})`)).status).toBe('settled')
    // The right parent with another child's reference is refused too; with its own child's reference it is served.
    expect((await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { resultRef: ${JSON.stringify(ref('result:b'))} })`)).error.code)
      .toBe('RLM_FAMILY_VIOLATION')
    expect((await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { resultRef: ${JSON.stringify(ref('result:a'))} })`)).status).toBe('settled')
    expect((await t.run(root2, `await rlm.readChildResult(${JSON.stringify(c.rlmChildId)})`)).status).toBe('settled')
    // The host was asked only for the reads that were served, always for the child's own recorded reference.
    expect(t.reads.every(read => read.resultRef === ref(`result:${read.resultRef === ref('result:a1') ? 'a1' : read.resultRef === ref('result:c') ? 'c' : 'a'}`))).toBe(true)
    expect(t.reads).toHaveLength(3)
    await t.ctx.root.fiber.dispose()
  })

  it('keeps the same authorization after a restart, derived from what is persisted', async () => {
    const t = await setup()
    const { a, b } = await t.settledTree()
    await t.ctx.root.fiber.dispose()
    const context = new Context()
    const recovered = new LocalRlmRuntime(context, t.root)
    await recovered.bindHost(t.root1, t.bindings)
    await recovered.bindHost(b.sessionId, t.bindings)
    const run = async (sessionId: RlmRuntimeSessionId, code: string, id: string): Promise<any> => (await recovered.executeCell({
      sessionId, commandId: RlmCommandId(id),
      code: `(async () => { try { ${code} } catch (error) { return { error: { code: error.code } } } })()`,
    })).value
    const read = `return await rlm.readChildResult(${JSON.stringify(a.rlmChildId)})`
    expect((await run(b.sessionId, read, 'sibling-after')).error.code).toBe('RLM_FAMILY_VIOLATION')
    expect((await run(t.root1, read, 'parent-after')).status).toBe('settled')
    await context.root.fiber.dispose()
  })

  it('says what a child that has not produced a result is: running, indeterminate, failed, or without one', async () => {
    const t = await setup({ behaviors: {
      running: { status: 'running' }, lost: { status: 'indeterminate' },
      failed: { status: 'failed', stored: content('partial output of the failed child') },
      empty: { status: 'settled', hasRef: false }, vanished: { status: 'settled', hasRef: true },
    } })
    const spawned = await Promise.all(['running', 'lost', 'failed', 'empty', 'vanished'].map(name => t.spawn(t.root1, name)))
    await new Promise(resolve => setTimeout(resolve, 60))
    type Child = (typeof spawned)[number]
    const [running, lost, failed, empty, vanished] = spawned as [Child, Child, Child, Child, Child]
    const read = (child: typeof running) => t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(child.rlmChildId)})`)
    expect(await read(running)).toMatchObject({ status: 'not_settled', lifecycle: 'running' })
    expect(await read(lost)).toMatchObject({ status: 'indeterminate', error: 'lost' })
    expect(await read(failed)).toMatchObject({ status: 'failed', error: expect.stringContaining('boom'), text: 'partial output of the failed child' })
    expect(await read(empty)).toMatchObject({ status: 'not_found', reason: 'the child recorded no result' })
    // A result the host no longer holds is missing, not empty.
    const missing = await read(vanished)
    expect(missing).toMatchObject({ status: 'not_found', resultRef: ref('result:vanished') })
    expect(missing).not.toHaveProperty('text')
    await t.ctx.root.fiber.dispose()
  })

  it('passes on the error of a reader that found the stored result damaged, and neither reports a settled result nor a missing one', async () => {
    const t = await setup({ readerError: 'The stored child result is damaged: its stop reason is missing' })
    const { a } = await t.settledTree()
    const failure = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a)})`)
    expect(failure).toEqual({ error: { code: 'RLM_UNAVAILABLE', message: expect.stringContaining('is damaged') } })
    const events = await t.service.readEvents({ sessionId: t.root1, after: 0, limit: 200 })
    expect(events.filter(event => event.type === 'rlm.child.result.read')).toEqual([])
    await t.ctx.root.fiber.dispose()
  })

  it('refuses a deleted child, and a host that cannot read results', async () => {
    const t = await setup()
    const { a } = await t.settledTree()
    await t.service.deleteChild(t.root1, a.rlmChildId, RlmCommandId('delete-a'))
    expect((await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)})`)).error.code).toBe('RLM_UNAVAILABLE')
    await t.ctx.root.fiber.dispose()
    const without = await setup({ noReader: true })
    const tree = await without.settledTree()
    expect((await without.run(without.root1, `await rlm.readChildResult(${JSON.stringify(tree.b.rlmChildId)})`)).error.code).toBe('RLM_UNAVAILABLE')
    await without.ctx.root.fiber.dispose()
  })

  it('refuses a range that does not exist, a cut inside a surrogate pair, and options it does not know', async () => {
    const t = await setup({ behaviors: { a: { status: 'settled', stored: content('x😀y'), hasRef: true } } })
    const { a } = await t.settledTree()
    const id = JSON.stringify(a.rlmChildId)
    const code = async (options: string) => (await t.run(t.root1, `await rlm.readChildResult(${id}, ${options})`)).error?.code
    expect(await code('{ offset: 5 }')).toBe('RLM_INVALID')
    expect(await code('{ offset: -1 }')).toBe('RLM_INVALID')
    expect(await code('{ offset: 1.5 }')).toBe('RLM_INVALID')
    expect(await code('{ limit: 0 }')).toBe('RLM_INVALID')
    expect(await code('{ offset: 2 }')).toBe('RLM_INVALID')
    expect(await code('{ path: "/etc/passwd" }')).toBe('RLM_INVALID')
    expect(await code('7')).toBe('RLM_INVALID')
    expect((await t.run(t.root1, 'await rlm.readChildResult(7)')).error.code).toBe('RLM_INVALID')
    // The end of the result is a valid, empty position.
    expect(await t.run(t.root1, `await rlm.readChildResult(${id}, { offset: 4 })`)).toMatchObject({ text: '', length: 0, truncated: false, nextOffset: null, complete: false })
    // A limit that would end between the halves of the pair stops before it.
    expect(await t.run(t.root1, `await rlm.readChildResult(${id}, { limit: 2 })`)).toMatchObject({ text: 'x', nextOffset: 1 })
    await t.ctx.root.fiber.dispose()
  })

  it('lists short summaries without the task, and leaves listSubagents with the fields it had', async () => {
    const t = await setup()
    await t.settledTree()
    const summaries = await t.run(t.root1, 'await rlm.childSummaries()')
    expect(summaries).toHaveLength(2)
    const a = summaries.find((summary: any) => summary.name === 'a')
    expect(a).toMatchObject({ lifecycle: 'settled', depth: 1, resultRef: ref('result:a'), previewTruncated: true })
    expect(a.preview).toHaveLength(200)
    expect(a).not.toHaveProperty('task')
    expect(a).not.toHaveProperty('sessionDir')
    const listed = await t.run(t.root1, 'await rlm.listSubagents()')
    expect(listed[0]).toMatchObject({ task: expect.stringContaining('task of'), sessionDir: expect.any(String), model: expect.anything() })
    expect(listed[0]).not.toHaveProperty('outputPreview')
    await t.ctx.root.fiber.dispose()
  })

  it('records in the event log what each read returned', async () => {
    const t = await setup()
    const { a } = await t.settledTree()
    const segment = await t.run(t.root1, `await rlm.readChildResult(${JSON.stringify(a.rlmChildId)}, { limit: 100 })`)
    const events = (JSON.parse(await readFile(join(t.root, 'state.json'), 'utf8')) as { events: Array<{ type: string; data: Record<string, unknown> }> }).events
    expect(events.filter(event => event.type === 'rlm.child.result.read').map(event => event.data)).toEqual([{
      childId: a.rlmChildId, commandId: 'exec-1', resultRef: ref('result:a'), offset: 0, length: segment.length, totalUnits: LONG.length,
      complete: false, truncated: true, segmentSha256: segment.segmentSha256, fullSha256: segment.fullSha256, status: 'settled',
    }])
    await t.ctx.root.fiber.dispose()
  })
})
