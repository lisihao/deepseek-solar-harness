import assert from 'node:assert/strict'
import { mkdtemp, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGameBroker, gradeGame } from './broker.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function action(name, data = {}) {
  return { name, data }
}

function listen(server, path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = error => {
      server.removeListener('listening', onListening)
      rejectPromise(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(path)
  })
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolvePromise => server.close(() => resolvePromise()))
}

async function startFakeBackend(engineSocket, options = {}) {
  const requests = []
  const sockets = new Set()
  let actionsTaken = 0
  let terminal = 'ACTIVE'
  let stopped = false
  const reply = (socket, value) => socket.write(`${JSON.stringify(value)}\n`)
  const dispatch = async (request, socket) => {
    requests.push(clone(request))
    if (request.op === 'act') {
      const names = request.actions.map(item => item.name)
      if (options.disconnectOnAction && names.includes(options.disconnectOnAction)) {
        actionsTaken += request.actions.length
        socket.destroy()
        return
      }
      if (options.delayOnAction && names.includes(options.delayOnAction)) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
      }
      actionsTaken += request.actions.length
      if (options.winOnAction && names.includes(options.winOnAction)) terminal = 'WIN'
    }
    reply(socket, {
      ok: true,
      value: {
        game_id: 'fake-00000000',
        state: terminal === 'WIN' ? 'WIN' : 'NOT_FINISHED',
        terminal,
        levels_completed: terminal === 'WIN' ? 1 : 0,
        available_actions: [1, 2, 3, 4, 5, 6, 7],
        frame: [[[actionsTaken]]],
        actions_taken: actionsTaken,
        actions_remaining: 500 - actionsTaken,
      },
    })
  }
  const server = createServer(socket => {
    sockets.add(socket)
    let buffered = Buffer.alloc(0)
    let queue = Promise.resolve()
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      let newline
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        const frame = buffered.subarray(0, newline + 1)
        buffered = buffered.subarray(newline + 1)
        const request = JSON.parse(frame.toString('utf8'))
        queue = queue.then(() => dispatch(request, socket))
      }
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await listen(server, engineSocket)
  return {
    requests,
    get actionsTaken() {
      return actionsTaken
    },
    exited: () => stopped,
    diagnostic: () => 'fake backend stopped',
    async stop() {
      if (stopped) return { stopped: true }
      stopped = true
      await closeServer(server, sockets)
      return { stopped: true }
    },
  }
}

async function makeRun(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arc-broker-test-'))
  const privateDirectory = join(root, 'trusted-engine')
  const publicDirectory = join(root, 'model-run')
  await mkdir(publicDirectory, { recursive: true, mode: 0o700 })
  let backend
  const broker = await createGameBroker({
    sourceRoot: join(root, 'unused-source'),
    corpus: join(root, 'unused-corpus'),
    python: join(root, 'unused-python'),
    adapterPath: join(root, 'unused-adapter.py'),
    gameId: 'fake-00000000',
    directory: privateDirectory,
    proxySocket: join(publicDirectory, 'guard.sock'),
    spawnBackend: async ({ engineSocket }) => {
      backend = await startFakeBackend(engineSocket, options)
      return backend
    },
  })
  return { root, broker, get backend() { return backend } }
}

async function destroyRun(run) {
  try {
    await run.broker.stop()
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
}

async function bootstrap(broker) {
  const observed = await broker.call('observe')
  assert.equal(observed.terminal, 'ACTIVE')
  const first = await broker.call('act', { actions: [action('ACTION1')] })
  assert.equal(first.terminal, 'ACTIVE')
  const second = await broker.call('act', { actions: [action('ACTION2')] })
  assert.equal(second.terminal, 'ACTIVE')
}

test('controller enforces the original bootstrap sequence before later operations', async () => {
  const run = await makeRun()
  try {
    await assert.rejects(run.broker.call('status'), /ARC_BOOTSTRAP/)
    assert.equal(run.backend.requests.length, 0)

    const inspected = await run.broker.inspect()
    assert.equal(inspected.terminal, 'ACTIVE')

    const firstObservation = await run.broker.call('observe')
    assert.equal(firstObservation.terminal, 'ACTIVE')
    await assert.rejects(run.broker.call('observe'), /ARC_BOOTSTRAP/)
    await assert.rejects(run.broker.call('act', { actions: [action('RESET')] }), /ARC_BOOTSTRAP/)

    await run.broker.call('act', { actions: [action('ACTION1')] })
    await assert.rejects(run.broker.call('status'), /ARC_BOOTSTRAP/)
    await run.broker.call('act', { actions: [action('ACTION2')] })
    const status = await run.broker.call('status')
    assert.equal(status.actions_taken, 2)
    assert.deepEqual(run.backend.requests.map(request => request.op), ['status', 'observe', 'act', 'act', 'status'])
  } finally {
    await destroyRun(run)
  }
})

test('controller rejects invalid batches and coordinates before they reach the engine', async () => {
  const run = await makeRun()
  try {
    await bootstrap(run.broker)
    const forwardedBefore = run.backend.requests.length
    await assert.rejects(run.broker.call('act', { actions: [] }), /ARC_PROXY_PROTOCOL/)
    await assert.rejects(run.broker.call('act', { actions: Array.from({ length: 21 }, () => action('ACTION1')) }), /ARC_PROXY_PROTOCOL/)
    await assert.rejects(run.broker.call('act', { actions: [action('ACTION6', { x: 64, y: 0 })] }), /ARC_PROXY_PROTOCOL/)
    await assert.rejects(run.broker.call('act', { actions: [action('ACTION1', null)] }), /ARC_PROXY_PROTOCOL/)
    await assert.rejects(run.broker.call('act', { actions: [action('ACTION1', { x: 1 })] }), /ARC_PROXY_PROTOCOL/)
    assert.equal(run.backend.requests.length, forwardedBefore)

    const result = await run.broker.call('act', { actions: [action('ACTION6', { x: 0, y: 63 })] })
    assert.equal(result.actions_taken, 3)
    assert.deepEqual(run.backend.requests.at(-1), { op: 'act', actions: [action('ACTION6', { x: 0, y: 63 })] })
  } finally {
    await destroyRun(run)
  }
})

test('controller serializes concurrent mutating requests in arrival order', async () => {
  const run = await makeRun({ delayOnAction: 'ACTION3' })
  try {
    await bootstrap(run.broker)
    const [left, right] = await Promise.all([
      run.broker.call('act', { actions: [action('ACTION3')] }),
      run.broker.call('act', { actions: [action('ACTION4')] }),
    ])
    assert.equal(left.actions_taken, 3)
    assert.equal(right.actions_taken, 4)
    assert.deepEqual(
      run.backend.requests.filter(request => request.op === 'act').map(request => request.actions[0].name),
      ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4'],
    )
  } finally {
    await destroyRun(run)
  }
})

test('disconnect after a mutating request closes the run and never replays it', async () => {
  const run = await makeRun({ disconnectOnAction: 'ACTION7' })
  try {
    await bootstrap(run.broker)
    await assert.rejects(run.broker.call('act', { actions: [action('ACTION7')] }), /ARC_UNKNOWN_EFFECT/)
    const actionSevenCalls = run.backend.requests.filter(request => request.op === 'act' && request.actions[0].name === 'ACTION7')
    assert.equal(actionSevenCalls.length, 1)
    await run.broker.stop()
    assert.equal(run.backend.requests.filter(request => request.op === 'act' && request.actions[0].name === 'ACTION7').length, 1)
  } finally {
    await destroyRun(run)
  }
})

test('only a trusted observation terminal WIN receives a game win, even after later errors', () => {
  const textOnly = gradeGame({ observation: { terminal: 'ACTIVE', levels_completed: 0, actions_taken: 2 }, modelText: 'I won the game.' })
  assert.equal(textOnly.win, 0)
  assert.equal(textOnly.observedWin, false)
  assert.equal(textOnly.unknown, true)

  const cleanupError = new Error('transport failed after observation')
  const observed = gradeGame({
    observation: { terminal: 'WIN', levels_completed: 1, actions_taken: 17 },
    error: cleanupError,
    stopReason: 'TRANSPORT_AFTER_WIN',
    modelText: 'this text is ignored',
  })
  assert.equal(observed.win, 1)
  assert.equal(observed.observedWin, true)
  assert.equal(observed.executionCompleted, false)
  assert.equal(observed.error, cleanupError)
  assert.equal(observed.levels, 1)
  assert.equal(observed.actions, 17)
})

test('stop removes only owned sockets and leaves a journal with request acknowledgements', async () => {
  const run = await makeRun()
  try {
    await bootstrap(run.broker)
    assert.equal((await lstat(run.broker.stateRoot)).isDirectory(), true)
    const receipt = await run.broker.stop()
    assert.equal(receipt.proxy.removed, true)
    assert.equal(receipt.engine.removed, true)
    await assert.rejects(lstat(run.broker.socket), error => error?.code === 'ENOENT')
    const journal = await readFile(join(run.root, 'trusted-engine', 'journal.jsonl'), 'utf8')
      .then(text => text.trim().split('\n').map(line => JSON.parse(line)))
    const acknowledgements = journal.filter(entry => entry.event === 'proxy-ack')
    assert.ok(acknowledgements.length >= 3)
    assert.ok(acknowledgements.some(entry => entry.response?.observation?.frameSha256))
    assert.ok(acknowledgements.every(entry => !Object.hasOwn(entry, 'rawFrame')))
  } finally {
    await destroyRun(run)
  }
})


test('retains a durably observed WIN when the engine cannot be inspected after cleanup', async () => {
  const run = await makeRun({ winOnAction: 'ACTION2' })
  try {
    await run.broker.call('observe')
    await run.broker.call('act', { actions: [action('ACTION1')] })
    await run.broker.call('act', { actions: [action('ACTION2')] })
    await run.broker.stop()
    await assert.rejects(run.broker.inspect(), /ARC_RUN_CLOSED/)
    const retained = run.broker.lastObservation()
    assert.equal(retained.terminal, 'WIN')
    retained.terminal = 'ACTIVE'
    assert.equal(run.broker.lastObservation().terminal, 'WIN')
    assert.equal(gradeGame({ observation: run.broker.lastObservation(), error: 'later close' }).win, 1)
    const journal = await readFile(join(run.root, 'trusted-engine', 'journal.jsonl'), 'utf8')
    assert.match(journal, /trusted-engine-observation/)
    assert.match(journal, /"terminal":"WIN"/)
  } finally { await destroyRun(run) }
})
