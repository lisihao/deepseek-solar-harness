import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { ResidentEngine } from '../src/core/engine.js'
import { ResidentError, type DriverRequest, type NativeDriver, type NativeToolBridge, type TaskGraph, type TaskNode, type TaskResult } from '../src/contracts.js'

const engines: ResidentEngine[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ResidentEngine durable graph scheduler', () => {
  it('persists admissions and results across a real database reopen without redispatching', async () => {
    const databasePath = await temporaryDatabasePath()
    let calls = 0
    const first = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls += 1
          request.onSession('native-session-1')
          return { output: 'first result', nativeSessionId: 'native-session-1' }
        },
      },
    })
    const request = { commandId: 'submit-persist', graph: graph('persist', [node('work', 'work')]) }
    const admission = await first.submit(request)
    await eventually(async () => expect((await first.inspect('persist')).status).toBe('completed'))
    expect(calls).toBe(1)

    const duplicate = await first.submit(request)
    expect(duplicate).toEqual(admission)
    await first.close()

    const reopened = await openEngine(databasePath, {
      codex: {
        async execute() {
          throw new Error('a settled node must not be redispatched after reopen')
        },
      },
    })
    const snapshot = await reopened.inspect('persist')
    expect(snapshot.status).toBe('completed')
    expect(snapshot.nodes).toMatchObject([{ id: 'work', status: 'succeeded', output: 'first result', nativeSessionId: 'native-session-1' }])
    expect(calls).toBe(1)
  })

  it('keeps the exclusive SQLite writer lock with the first daemon', async () => {
    const databasePath = await temporaryDatabasePath()
    const first = await openEngine(databasePath, {
      codex: { async execute() { return { output: 'ok' } } },
    })

    await expect(openEngine(databasePath, {
      codex: { async execute() { return { output: 'second' } } },
    })).rejects.toMatchObject({ code: 'ENGINE_ALREADY_RUNNING' })

    await first.submit({ commandId: 'writer-still-owns-db', graph: graph('writer-lock', [node('task', 'task')]) })
    await eventually(async () => expect((await first.inspect('writer-lock')).status).toBe('completed'))
  })

  it('fences a crash-recovered cancelling native effect and never replays it after reopen', async () => {
    const databasePath = await temporaryDatabasePath()
    let calls = 0
    const driver: NativeDriver = {
      async execute(request) {
        calls += 1
        request.onSession('native-uncertain')
        return { output: 'originally settled', nativeSessionId: 'native-uncertain' }
      },
    }
    const first = await openEngine(databasePath, { codex: driver })
    await first.submit({ commandId: 'submit-uncertain', graph: graph('uncertain', [node('task', 'pending', { sessionKey: 'uncertain-session' })]) })
    await eventually(async () => expect((await first.inspect('uncertain')).status).toBe('completed'))
    await first.close()

    // This is the durable state a forced process stop can leave: it bypasses
    // normal close, so open() must fence instead of replaying its command.
    const crashed = new DatabaseSync(databasePath)
    crashed.exec(`
      UPDATE graphs SET status = 'cancelling', cancel_requested = 1 WHERE id = 'uncertain';
      UPDATE nodes
        SET status = 'cancelling', output = NULL, error_code = NULL, error_message = NULL,
            wait_reason = NULL
        WHERE graph_id = 'uncertain' AND node_id = 'task';
      UPDATE attempts SET status = 'cancel_requested', settled_at = NULL
        WHERE graph_id = 'uncertain' AND node_id = 'task' AND attempt = 1;
      UPDATE native_sessions
        SET state = 'active', owner_graph_id = 'uncertain', owner_node_id = 'task'
        WHERE session_key = 'uncertain-session';
    `)
    crashed.close()

    const reopened = await openEngine(databasePath, { codex: driver })
    const snapshot = await reopened.inspect('uncertain')
    expect(snapshot.status).toBe('indeterminate')
    expect(snapshot.nodes).toMatchObject([{ id: 'task', status: 'indeterminate', attempt: 1 }])
    expect(calls).toBe(1)
  })

  it('runs a DAG in dependency order, blocks descendants after a failed dependency, and continues independent work', async () => {
    const databasePath = await temporaryDatabasePath()
    const calls: string[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`session-${request.prompt}`)
          if (request.prompt === 'b') throw codedError('BAD_DEPENDENCY', 'b failed')
          return { output: request.prompt }
        },
      },
    }, { maxParallel: 1 })
    await engine.submit({
      commandId: 'submit-dag',
      graph: graph('dag', [
        node('a', 'a'),
        node('b', 'b', { dependsOn: ['a'] }),
        node('c', 'c', { dependsOn: ['b'] }),
        node('d', 'd', { dependsOn: ['a'] }),
      ]),
    })

    await eventually(async () => expect((await engine.inspect('dag')).status).toBe('failed'))
    const snapshot = await engine.inspect('dag')
    expect(calls).toEqual(['a', 'b', 'd'])
    expect(snapshot.nodes).toMatchObject([
      { id: 'a', status: 'succeeded' },
      { id: 'b', status: 'failed', error: { code: 'BAD_DEPENDENCY' } },
      { id: 'c', status: 'blocked' },
      { id: 'd', status: 'succeeded' },
    ])

    const cyclic = graph('cycle', [
      node('one', 'one', { dependsOn: ['two'] }),
      node('two', 'two', { dependsOn: ['one'] }),
    ])
    await expect(engine.submit({ commandId: 'submit-cycle', graph: cyclic })).rejects.toMatchObject({ code: 'GRAPH_INVALID' })
  })

  it('serializes overlapping cross-graph write/read scopes until the first graph settles', async () => {
    const databasePath = await temporaryDatabasePath()
    const workspaceRoot = await temporaryDirectory()
    const workspace = join(workspaceRoot, 'workspace')
    const workspaceAlias = join(workspaceRoot, 'workspace-alias')
    await mkdir(workspace)
    await symlink(workspace, workspaceAlias)
    const waits: Array<ReturnType<typeof deferred<TaskResult>>> = []
    const calls: DriverRequest[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request)
          request.onSession(`session-${calls.length}`)
          const wait = deferred<TaskResult>()
          waits.push(wait)
          return wait.promise
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-write',
      graph: graph('writer', [node('writer-node', 'writer', { scope: { write: ['project'] } })], workspace),
    })
    await eventually(() => expect(calls).toHaveLength(1))
    await engine.submit({
      commandId: 'submit-read',
      graph: graph('reader', [node('reader-node', 'reader', { scope: { read: ['project/file.ts'] } })], workspaceAlias),
    })
    await delay(40)
    expect(calls).toHaveLength(1)
    expect((await engine.inspect('reader')).nodes[0]).toMatchObject({ status: 'ready', waitReason: 'scope-conflict' })

    waits[0]?.resolve({ output: 'writer complete' })
    await eventually(() => expect(calls).toHaveLength(2))
    waits[1]?.resolve({ output: 'reader complete' })
    await eventually(async () => expect((await engine.inspect('reader')).status).toBe('completed'))
  })

  it.each([
    ['read-scoped nodes run together', { scope: { read: ['.'] } }, 2],
    ['nodes without a scope queue behind each other', {}, 1],
  ] as const)('within one graph and cwd, %s', async (_name, extra, concurrent) => {
    const databasePath = await temporaryDatabasePath()
    const workspace = await temporaryDirectory()
    const waits: Array<ReturnType<typeof deferred<TaskResult>>> = []
    const calls: DriverRequest[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request)
          request.onSession(`session-${calls.length}`)
          const wait = deferred<TaskResult>()
          waits.push(wait)
          return wait.promise
        },
      },
    })
    await engine.submit({
      commandId: `submit-parallel-${concurrent}`,
      graph: graph('parallel', [node('a', 'first', extra), node('b', 'second', extra)], workspace),
    })
    await eventually(() => expect(calls.length).toBeGreaterThan(0))
    await delay(40)
    expect(calls).toHaveLength(concurrent)
    waits.forEach(wait => wait.resolve({ output: 'done' }))
    await eventually(() => expect(calls).toHaveLength(2))
    waits.forEach(wait => wait.resolve({ output: 'done' }))
    await eventually(async () => expect((await engine.inspect('parallel')).status).toBe('completed'))
  })

  it('compares declared scopes as absolute paths across nested workspace roots', async () => {
    const databasePath = await temporaryDatabasePath()
    const root = await temporaryDirectory()
    const nested = join(root, 'sub')
    await mkdir(nested)
    const waits: Array<ReturnType<typeof deferred<TaskResult>>> = []
    const calls: string[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`nested-${request.prompt}`)
          const wait = deferred<TaskResult>()
          waits.push(wait)
          return wait.promise
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-parent-scope',
      graph: graph('parent-scope', [node('parent-node', 'parent', { scope: { write: ['sub/file.txt'] } })], root),
    })
    await eventually(() => expect(calls).toEqual(['parent']))
    await engine.submit({
      commandId: 'submit-nested-scope',
      graph: graph('nested-scope', [node('nested-node', 'nested', { scope: { write: ['file.txt'] } })], nested),
    })
    await eventually(async () => expect((await engine.inspect('nested-scope')).nodes[0]).toMatchObject({ status: 'ready', waitReason: 'scope-conflict' }))
    expect(calls).toEqual(['parent'])
    waits[0]?.resolve({ output: 'parent complete' })
    await eventually(() => expect(calls).toEqual(['parent', 'nested']))
    waits[1]?.resolve({ output: 'nested complete' })
    await eventually(async () => expect((await engine.inspect('nested-scope')).status).toBe('completed'))
  })

  it('reserves future session profiles at admission and persists defensive admission conflicts without killing the scheduler', async () => {
    const databasePath = await temporaryDatabasePath()
    let clock = 0
    const calls: string[] = []
    const driver: NativeDriver = {
      async execute(request) {
        calls.push(request.prompt)
        request.onSession(`profile-${request.prompt}`)
        return { output: request.prompt }
      },
    }
    const engine = await openEngine(databasePath, { codex: driver }, { now: () => clock })
    const reserved = {
      ...graph('future-profile', [node('future', 'future', { sessionKey: 'future-session', profile: { model: 'first' } })]),
      notBefore: 100,
    }
    await engine.submit({ commandId: 'submit-future-profile', graph: reserved })
    await expect(engine.submit({
      commandId: 'submit-conflicting-future-profile',
      graph: {
        ...graph('future-profile-conflict', [node('future-conflict', 'future-conflict', { sessionKey: 'future-session', profile: { model: 'second' } })]),
        notBefore: 100,
      },
    })).rejects.toMatchObject({ code: 'PROFILE_CONFLICT' })
    clock = 100
    await eventually(async () => expect((await engine.inspect('future-profile')).status).toBe('completed'))
    expect(calls).toEqual(['future'])

    // The completed graph cannot exercise its old session again, so add a
    // future node whose durable reservation is intentionally corrupted.
    await engine.submit({
      commandId: 'submit-defensive-conflict',
      graph: {
        ...graph('defensive-conflict', [node('bad', 'bad', { sessionKey: 'defensive-session', profile: { model: 'expected' } })]),
        notBefore: 200,
      },
    })
    await engine.close()
    const corrupted = new DatabaseSync(databasePath)
    corrupted.prepare(
      `UPDATE native_sessions SET profile_json = ?
       WHERE executor = 'codex' AND session_key = 'defensive-session'`,
    ).run('{"model":"different"}')
    corrupted.close()

    clock = 200
    const defended = await openEngine(databasePath, { codex: driver }, { now: () => clock })
    await eventually(async () => expect((await defended.inspect('defensive-conflict')).status).toBe('failed'))
    expect((await defended.inspect('defensive-conflict')).nodes).toMatchObject([
      { id: 'bad', status: 'blocked', error: { code: 'PROFILE_CONFLICT' } },
    ])
    await defended.submit({ commandId: 'submit-after-conflict', graph: graph('after-conflict', [node('safe', 'safe')]) })
    await eventually(async () => expect((await defended.inspect('after-conflict')).status).toBe('completed'))
    expect(calls).toContain('safe')
  })

  it('uses unambiguous persisted attempt command identities for slash-containing graph and node ids', async () => {
    const databasePath = await temporaryDatabasePath()
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          request.onSession(`identity-${request.prompt}`)
          return { output: request.prompt }
        },
      },
    })
    await engine.submit({ commandId: 'submit-id-one', graph: graph('a/b', [node('c', 'one')]) })
    await engine.submit({ commandId: 'submit-id-two', graph: graph('a', [node('b/c', 'two')]) })
    await eventually(async () => expect((await engine.inspect('a/b')).status).toBe('completed'))
    await eventually(async () => expect((await engine.inspect('a')).status).toBe('completed'))
    const firstId = (await engine.inspect('a/b')).nodes[0]?.commandId
    const secondId = (await engine.inspect('a')).nodes[0]?.commandId
    expect(firstId).toMatch(/^attempt:[a-f0-9]{64}$/)
    expect(secondId).toMatch(/^attempt:[a-f0-9]{64}$/)
    expect(firstId).not.toBe(secondId)
  })

  it('uses only declared known-code retries and settles a result returned after cancellation as cancelled', async () => {
    const retryDatabase = await temporaryDatabasePath()
    let retryCalls = 0
    const retryEngine = await openEngine(retryDatabase, {
      codex: {
        async execute(request) {
          retryCalls += 1
          request.onSession(`retry-session-${retryCalls}`)
          if (retryCalls === 1) throw codedError('TEMPORARY', 'retry me')
          return { output: 'recovered' }
        },
      },
    })
    await retryEngine.submit({
      commandId: 'submit-retry',
      graph: graph('retry', [node('retry-node', 'retry', { retry: { maxAttempts: 2, delayMs: 0, codes: ['TEMPORARY'] } })]),
    })
    await eventually(async () => expect((await retryEngine.inspect('retry')).status).toBe('completed'))
    expect((await retryEngine.inspect('retry')).nodes).toMatchObject([{ id: 'retry-node', status: 'succeeded', attempt: 2 }])
    expect(retryCalls).toBe(2)

    const indeterminateDatabase = await temporaryDatabasePath()
    let indeterminateCalls = 0
    const indeterminateEngine = await openEngine(indeterminateDatabase, {
      codex: {
        async execute() {
          indeterminateCalls += 1
          throw codedError('COMMAND_INDETERMINATE', 'native effect is not replayable')
        },
      },
    })
    await indeterminateEngine.submit({
      commandId: 'submit-indeterminate-code',
      graph: graph('indeterminate-code', [node('unknown-node', 'unknown', { retry: { maxAttempts: 3, delayMs: 0, codes: ['COMMAND_INDETERMINATE'] } })]),
    })
    await eventually(async () => expect((await indeterminateEngine.inspect('indeterminate-code')).status).toBe('indeterminate'))
    expect(indeterminateCalls).toBe(1)
    const indeterminate = await indeterminateEngine.inspect('indeterminate-code')
    expect(indeterminate.nodes).toMatchObject([{ id: 'unknown-node', status: 'indeterminate', error: { code: 'COMMAND_INDETERMINATE' } }])
    await indeterminateEngine.resolve({
      commandId: 'resolve-indeterminate-code',
      graphId: 'indeterminate-code',
      nodeId: 'unknown-node',
      decision: 'fail',
      expectedRevision: indeterminate.revision,
    })
    await eventually(async () => expect((await indeterminateEngine.inspect('indeterminate-code')).status).toBe('failed'))

    const cancelDatabase = await temporaryDatabasePath()
    const late = deferred<TaskResult>()
    let started = 0
    const cancelEngine = await openEngine(cancelDatabase, {
      codex: {
        async execute(request) {
          started += 1
          request.onSession('cancel-session')
          return late.promise
        },
      },
    })
    await cancelEngine.submit({
      commandId: 'submit-cancel',
      graph: graph('cancel', [node('cancel-node', 'cancel', { sessionKey: 'serial-session' })]),
    })
    await eventually(() => expect(started).toBe(1))
    const beforeCancel = await cancelEngine.inspect('cancel')
    const cancellationReceipt = await cancelEngine.control({
      commandId: 'control-cancel',
      graphId: 'cancel',
      action: 'cancel',
      expectedRevision: beforeCancel.revision,
    })
    expect(cancellationReceipt.status).toBe('cancelling')
    expect(cancellationReceipt.nodes).toMatchObject([{ id: 'cancel-node', status: 'cancelling' }])
    late.resolve({ output: 'must be fenced', nativeSessionId: 'cancel-session' })
    await eventually(async () => expect((await cancelEngine.inspect('cancel')).status).toBe('cancelled'))
    const cancelled = await cancelEngine.inspect('cancel')
    expect(cancelled.nodes).toMatchObject([{ id: 'cancel-node', status: 'cancelled' }])
    expect(cancelled.nodes[0]?.output).toBeUndefined()
  })

  it('keeps an unknown cancelled effect indeterminate until the owner resolves it', async () => {
    const databasePath = await temporaryDatabasePath()
    const unknown = deferred<TaskResult>()
    const calls: string[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`unknown-cancel-${request.prompt}`)
          if (request.prompt === 'unknown') return unknown.promise
          return { output: request.prompt, nativeSessionId: `unknown-cancel-${request.prompt}` }
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-cancel-unknown',
      graph: graph('cancel-unknown', [
        node('unknown', 'unknown', {
          scope: { write: ['shared'] },
          retry: { maxAttempts: 3, delayMs: 0, codes: ['COMMAND_INDETERMINATE'] },
        }),
      ]),
    })
    await eventually(() => expect(calls).toEqual(['unknown']))
    await engine.submit({
      commandId: 'submit-blocked-by-unknown-cancel',
      graph: graph('blocked-by-unknown-cancel', [node('later', 'later', { scope: { read: ['shared/file.txt'] } })]),
    })
    await eventually(async () => expect((await engine.inspect('blocked-by-unknown-cancel')).nodes[0]).toMatchObject({
      status: 'ready',
      waitReason: 'scope-conflict',
    }))

    const beforeCancel = await engine.inspect('cancel-unknown')
    const cancellationReceipt = await engine.control({
      commandId: 'control-cancel-unknown',
      graphId: 'cancel-unknown',
      action: 'cancel',
      expectedRevision: beforeCancel.revision,
    })
    expect(cancellationReceipt.status).toBe('cancelling')
    expect(cancellationReceipt.nodes).toMatchObject([{ id: 'unknown', status: 'cancelling' }])
    await expect(engine.resolve({
      commandId: 'resolve-while-cancelling',
      graphId: 'cancel-unknown',
      nodeId: 'unknown',
      decision: 'fail',
      expectedRevision: cancellationReceipt.revision,
    })).rejects.toMatchObject({ code: 'ACTIVE' })

    unknown.reject(new ResidentError('COMMAND_INDETERMINATE', 'native cancellation outcome is unknown'))
    await eventually(async () => expect((await engine.inspect('cancel-unknown')).status).toBe('indeterminate'))
    const indeterminate = await engine.inspect('cancel-unknown')
    expect(indeterminate.nodes).toMatchObject([{ id: 'unknown', status: 'indeterminate', error: { code: 'COMMAND_INDETERMINATE' } }])
    expect(calls).toEqual(['unknown'])
    await eventually(async () => expect((await engine.inspect('blocked-by-unknown-cancel')).nodes[0]).toMatchObject({
      status: 'ready',
      waitReason: 'scope-conflict-indeterminate',
    }))

    await engine.resolve({
      commandId: 'resolve-cancel-unknown',
      graphId: 'cancel-unknown',
      nodeId: 'unknown',
      decision: 'fail',
      expectedRevision: indeterminate.revision,
    })
    await eventually(async () => expect((await engine.inspect('cancel-unknown')).status).toBe('cancelled'))
    await eventually(() => expect(calls).toEqual(['unknown', 'later']))
  })

  it('allows cancelling remaining work after a parallel node becomes indeterminate', async () => {
    const databasePath = await temporaryDatabasePath()
    const unknown = deferred<TaskResult>()
    const remaining = deferred<TaskResult>()
    const calls: string[] = []
    let remainingAborts = 0
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`parallel-cancel-${request.prompt}`)
          if (request.prompt === 'unknown') return unknown.promise
          if (request.prompt === 'remaining') {
            request.signal.addEventListener('abort', () => { remainingAborts += 1 }, { once: true })
            return remaining.promise
          }
          return { output: request.prompt }
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-parallel-indeterminate',
      graph: graph('parallel-indeterminate', [
        node('unknown', 'unknown', { sessionKey: 'parallel-unknown-lane', scope: { read: ['unknown'] } }),
        node('remaining', 'remaining', { scope: { read: ['remaining'] } }),
        node('waiting', 'waiting', { dependsOn: ['unknown'], scope: { read: ['waiting'] } }),
      ]),
    })
    await eventually(() => expect(calls).toEqual(['unknown', 'remaining']))
    unknown.reject(new ResidentError('COMMAND_INDETERMINATE', 'first native outcome is unknown'))
    await eventually(async () => expect(await engine.inspect('parallel-indeterminate')).toMatchObject({
      status: 'indeterminate',
      nodes: [
        { id: 'unknown', status: 'indeterminate' },
        { id: 'remaining', status: 'running' },
        { id: 'waiting', status: 'pending' },
      ],
    }))

    const beforeCancel = await engine.inspect('parallel-indeterminate')
    const cancellationReceipt = await engine.control({
      commandId: 'control-parallel-indeterminate',
      graphId: 'parallel-indeterminate',
      action: 'cancel',
      expectedRevision: beforeCancel.revision,
    })
    expect(cancellationReceipt).toMatchObject({
      status: 'indeterminate',
      nodes: [
        { id: 'unknown', status: 'indeterminate' },
        { id: 'remaining', status: 'cancelling' },
        { id: 'waiting', status: 'cancelled' },
      ],
    })
    await eventually(() => expect(remainingAborts).toBe(1))
    await expect(engine.resolve({
      commandId: 'resolve-parallel-while-active',
      graphId: 'parallel-indeterminate',
      nodeId: 'unknown',
      decision: 'fail',
      expectedRevision: cancellationReceipt.revision,
    })).rejects.toMatchObject({ code: 'ACTIVE' })
    remaining.reject(codedError('ABORTED', 'remaining native work confirmed cancellation'))
    await eventually(async () => expect(await engine.inspect('parallel-indeterminate')).toMatchObject({
      status: 'indeterminate',
      nodes: [
        { id: 'unknown', status: 'indeterminate' },
        { id: 'remaining', status: 'cancelled' },
        { id: 'waiting', status: 'cancelled' },
      ],
    }))

    await engine.submit({
      commandId: 'submit-fenced-parallel-lane',
      graph: graph('fenced-parallel-lane', [node('fenced', 'fenced', { sessionKey: 'parallel-unknown-lane', scope: { read: ['fenced'] } })]),
    })
    await eventually(async () => expect((await engine.inspect('fenced-parallel-lane')).nodes[0]).toMatchObject({
      status: 'ready',
      waitReason: 'session-fenced',
    }))
  })

  it('releases a confirmed cancelled native session lane for later work', async () => {
    const databasePath = await temporaryDatabasePath()
    const calls: DriverRequest[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request)
          const sessionId = request.nativeSessionId ?? `confirmed-cancel-${request.prompt}`
          request.onSession(sessionId)
          if (request.prompt === 'hold') {
            return new Promise<TaskResult>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(codedError('ABORTED', 'native cancellation confirmed')), { once: true })
            })
          }
          return { output: 'later', nativeSessionId: sessionId }
        },
      },
    })
    await engine.submit({
      commandId: 'submit-confirmed-cancel',
      graph: graph('confirmed-cancel', [node('hold', 'hold', { sessionKey: 'confirmed-cancel-lane' })]),
    })
    await eventually(() => expect(calls).toHaveLength(1))
    const beforeCancel = await engine.inspect('confirmed-cancel')
    const cancellationReceipt = await engine.control({
      commandId: 'control-confirmed-cancel',
      graphId: 'confirmed-cancel',
      action: 'cancel',
      expectedRevision: beforeCancel.revision,
    })
    expect(cancellationReceipt.status).toBe('cancelling')
    await eventually(async () => expect((await engine.inspect('confirmed-cancel')).status).toBe('cancelled'))

    await engine.submit({
      commandId: 'submit-after-confirmed-cancel',
      graph: graph('after-confirmed-cancel', [node('later', 'later', { sessionKey: 'confirmed-cancel-lane' })]),
    })
    await eventually(async () => expect((await engine.inspect('after-confirmed-cancel')).status).toBe('completed'))
    expect(calls).toHaveLength(2)
    expect(calls[1]?.nativeSessionId).toBe('confirmed-cancel-hold')
  })

  it('keeps unknown native effects fenced until owner resolution across later same-graph and same-key cross-graph work', async () => {
    const databasePath = await temporaryDatabasePath()
    const unknown = deferred<TaskResult>()
    const calls: string[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`session-${request.prompt}`)
          if (request.prompt === 'unknown') return unknown.promise
          return { output: request.prompt }
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-unknown-owner',
      graph: graph('unknown-owner', [
        node('unknown', 'unknown', { sessionKey: 'shared-native-session', scope: { write: ['work'] } }),
        node('later', 'later', { sessionKey: 'shared-native-session', scope: { read: ['later'] } }),
      ]),
    })
    await eventually(() => expect(calls).toEqual(['unknown']))
    await engine.submit({
      commandId: 'submit-cross-graph-session',
      graph: graph('cross-graph-session', [node('cross', 'cross', { sessionKey: 'shared-native-session', scope: { read: ['other'] } })]),
    })
    await delay(30)
    expect(calls).toEqual(['unknown'])

    unknown.reject(new ResidentError('COMMAND_INDETERMINATE', 'transport outcome is unknown'))
    await eventually(async () => expect((await engine.inspect('unknown-owner')).status).toBe('indeterminate'))
    await eventually(async () => expect((await engine.inspect('cross-graph-session')).nodes[0]).toMatchObject({ status: 'ready', waitReason: 'session-fenced' }))
    expect(calls).toEqual(['unknown'])

    const owner = await engine.inspect('unknown-owner')
    await engine.resolve({
      commandId: 'resolve-unknown-owner',
      graphId: 'unknown-owner',
      nodeId: 'unknown',
      decision: 'fail',
      expectedRevision: owner.revision,
    })
    await eventually(() => expect(calls).toEqual(expect.arrayContaining(['unknown', 'later', 'cross'])))
  })

  it('serializes overlapping declared scopes within one graph', async () => {
    const databasePath = await temporaryDatabasePath()
    const waits: Array<ReturnType<typeof deferred<TaskResult>>> = []
    const calls: string[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          calls.push(request.prompt)
          request.onSession(`same-graph-${request.prompt}`)
          const wait = deferred<TaskResult>()
          waits.push(wait)
          return wait.promise
        },
      },
    }, { maxParallel: 2 })
    await engine.submit({
      commandId: 'submit-same-graph-scopes',
      graph: graph('same-graph-scopes', [
        node('first', 'first', { scope: { write: ['shared'] } }),
        node('second', 'second', { scope: { write: ['shared/file.txt'] } }),
      ]),
    })
    await eventually(() => expect(calls).toEqual(['first']))
    await eventually(async () => expect((await engine.inspect('same-graph-scopes')).nodes[1]).toMatchObject({ status: 'ready', waitReason: 'scope-conflict' }))
    waits[0]?.resolve({ output: 'first done' })
    await eventually(() => expect(calls).toEqual(['first', 'second']))
    waits[1]?.resolve({ output: 'second done' })
    await eventually(async () => expect((await engine.inspect('same-graph-scopes')).status).toBe('completed'))
  })

  it('waits for a registered runtime bridge, binds its catalog and profile to a session, and journals tool calls once', async () => {
    const databasePath = await temporaryDatabasePath()
    let bridgeAvailable = false
    let toolEffects = 0
    const firstBridge: NativeToolBridge = {
      tools: [{ name: 'workspace.read', description: 'Read one workspace file', inputSchema: { type: 'object' } }],
      async call() {
        return { content: 'unused in this test', isError: false }
      },
    }
    let currentBridge = firstBridge
    const requests: DriverRequest[] = []
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          requests.push(request)
          request.onSession('bridge-session')
          return { output: 'with bridge', nativeSessionId: 'bridge-session' }
        },
      },
    }, {
      resolveBridge: (id) => bridgeAvailable && id === 'workspace' ? currentBridge : undefined,
    })
    await engine.registerBridgeCatalog('workspace', firstBridge.tools)
    await engine.submit({
      commandId: 'submit-bridge-wait',
      graph: {
        ...graph('bridge-wait', [node('bridge-node', 'bridge', { sessionKey: 'bound-session', profile: { model: 'gpt-test', reasoningEffort: 'high' } })]),
        bridgeId: 'workspace',
      },
    })
    await eventually(async () => expect((await engine.inspect('bridge-wait')).nodes[0]).toMatchObject({ status: 'ready', waitReason: 'BRIDGE_UNAVAILABLE' }))
    expect(requests).toHaveLength(0)

    bridgeAvailable = true
    await eventually(async () => expect((await engine.inspect('bridge-wait')).status).toBe('completed'))
    expect(requests[0]).toMatchObject({ profile: { model: 'gpt-test', reasoningEffort: 'high' }, bridge: firstBridge })

    await expect(engine.submit({
      commandId: 'submit-profile-conflict',
      graph: {
        ...graph('profile-conflict', [node('next', 'next', { sessionKey: 'bound-session', profile: { model: 'other-model' } })]),
        bridgeId: 'workspace',
      },
    })).rejects.toMatchObject({ code: 'PROFILE_CONFLICT' })

    const changedBridge: NativeToolBridge = {
      tools: [
        { name: 'workspace.read', description: 'Read one workspace file', inputSchema: { type: 'object' } },
        { name: 'workspace.write', description: 'Write one workspace file', inputSchema: { type: 'object' } },
      ],
      async call() {
        return { content: 'unused', isError: false }
      },
    }
    currentBridge = changedBridge
    await engine.registerBridgeCatalog('workspace', changedBridge.tools)
    await expect(engine.submit({
      commandId: 'submit-catalog-conflict',
      graph: {
        ...graph('catalog-conflict', [node('next', 'next', { sessionKey: 'bound-session', profile: { model: 'gpt-test', reasoningEffort: 'high' } })]),
        bridgeId: 'workspace',
      },
    })).rejects.toMatchObject({ code: 'SESSION_PROFILE_CONFLICT' })

    const toolResult = await engine.executeToolCall('tool-command', 'call-one', 'workspace.read', { path: 'README.md' }, async () => {
      toolEffects += 1
      return { content: 'file contents', isError: false }
    })
    const cached = await engine.executeToolCall('tool-command', 'call-one', 'workspace.read', { path: 'README.md' }, async () => {
      toolEffects += 1
      return { content: 'must not run', isError: false }
    })
    expect(toolResult).toEqual(cached)
    expect(toolEffects).toBe(1)
    await expect(engine.executeToolCall('tool-command', 'call-one', 'workspace.read', { path: 'other.md' }, async () => ({ content: '', isError: false })))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })

    const pending = deferred<{ content: string; isError: boolean }>()
    const pendingCall = engine.executeToolCall('tool-command', 'call-two', 'workspace.read', { path: 'pending.md' }, async () => pending.promise)
    await eventually(async () => {
      await expect(engine.executeToolCall('tool-command', 'call-two', 'workspace.read', { path: 'pending.md' }, async () => ({ content: '', isError: false })))
        .rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    })
    pending.resolve({ content: 'settled later', isError: false })
    await expect(pendingCall).resolves.toEqual({ content: 'settled later', isError: false })
  })

  it('settles a normal close as cancellation while reserving indeterminate for crash recovery', async () => {
    const databasePath = await temporaryDatabasePath()
    let started = 0
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          started += 1
          request.onSession('close-session')
          return new Promise<TaskResult>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(codedError('ABORTED', 'driver acknowledged cancellation')), { once: true })
          })
        },
      },
    })
    await engine.submit({ commandId: 'submit-close', graph: graph('normal-close', [node('task', 'long')]) })
    await eventually(() => expect(started).toBe(1))
    await engine.close()

    const reopened = await openEngine(databasePath, { codex: { async execute() { return { output: 'unexpected' } } } })
    const snapshot = await reopened.inspect('normal-close')
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.nodes).toMatchObject([{ id: 'task', status: 'cancelled' }])
  })

  it('keeps a shutdown cancellation indeterminate when the driver cannot confirm its outcome', async () => {
    const databasePath = await temporaryDatabasePath()
    let started = 0
    const engine = await openEngine(databasePath, {
      codex: {
        async execute(request) {
          started += 1
          request.onSession('close-unknown-session')
          return new Promise<TaskResult>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new ResidentError('COMMAND_INDETERMINATE', 'shutdown could not confirm the native effect')),
              { once: true },
            )
          })
        },
      },
    })
    await engine.submit({
      commandId: 'submit-close-unknown',
      graph: graph('close-unknown', [node('task', 'long', { sessionKey: 'close-unknown-lane', scope: { write: ['shared'] } })]),
    })
    await eventually(() => expect(started).toBe(1))
    await engine.close()

    const reopened = await openEngine(databasePath, { codex: { async execute() { return { output: 'must not replay' } } } })
    const snapshot = await reopened.inspect('close-unknown')
    expect(snapshot.status).toBe('indeterminate')
    expect(snapshot.nodes).toMatchObject([{ id: 'task', status: 'indeterminate', error: { code: 'COMMAND_INDETERMINATE' } }])
  })
})

async function openEngine(databasePath: string, drivers: { codex: NativeDriver }, options: ConstructorParameters<typeof ResidentEngine>[2] = {}): Promise<ResidentEngine> {
  const engine = new ResidentEngine(databasePath, drivers, { tickMs: 5, ...options })
  engines.push(engine)
  await engine.open()
  return engine
}

function graph(id: string, nodes: readonly TaskNode[], cwd = process.cwd()): TaskGraph {
  return {
    formatVersion: 1,
    id,
    label: id,
    cwd,
    maxParallel: 2,
    nodes,
  }
}

function node(id: string, prompt: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id, executor: 'codex', prompt, ...extra }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await temporaryDirectory()
  return join(directory, 'resident.sqlite')
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'native-resident-core-'))
  temporaryDirectories.push(directory)
  return directory
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await delay(5)
    }
  }
  throw lastError
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
