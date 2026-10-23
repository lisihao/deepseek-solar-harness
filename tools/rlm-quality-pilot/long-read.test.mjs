import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import test from 'node:test'

import { createLongReadDispatcher, createLongReadProfile } from './long-read.mjs'

async function withSlowServer(operation) {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('first')
    setTimeout(() => response.end(' second'), 1_500)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/slow`
  try { return await operation({ url, requests: () => requests }) } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function withTlsHandshakeHang(operation) {
  let connections = 0
  const sockets = new Set()
  const server = createTcpServer(socket => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  let listening = false
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    listening = true
    const address = server.address()
    const url = `https://127.0.0.1:${address.port}/backend-api/codex/responses`
    return await operation({ url, connections: () => connections })
  } finally {
    for (const socket of sockets) socket.destroy()
    if (listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}

test('dispatcher replaces fetch-provided bodyTimeout and completes the same slow local response once', async () => {
  await withSlowServer(async ({ url, requests }) => {
    const short = createLongReadDispatcher({ bodyTimeoutMs: 50 })
    try {
      await assert.rejects(
        () => globalThis.fetch(url, { dispatcher: short.dispatcher, bodyTimeout: 300_000 }).then(response => response.text()),
        error => error?.code === 'UND_ERR_BODY_TIMEOUT' || error?.cause?.code === 'UND_ERR_BODY_TIMEOUT',
      )
    } finally { await short.close() }
    const long = createLongReadDispatcher({ bodyTimeoutMs: 5_000 })
    try {
      const response = await globalThis.fetch(url, { dispatcher: long.dispatcher, bodyTimeout: 1 })
      assert.equal(await response.text(), 'first second')
    } finally { await long.close() }
    assert.equal(requests(), 2, 'each fetch performs exactly one HTTP request; no retry is introduced')
  })
})

test('dispatcher preserves AbortSignal cancellation', async () => {
  await withSlowServer(async ({ url }) => {
    const profile = createLongReadDispatcher({ bodyTimeoutMs: 5_000 })
    const controller = new AbortController()
    try {
      const response = await globalThis.fetch(url, { dispatcher: profile.dispatcher, signal: controller.signal })
      const reason = new Error('fixture abort')
      controller.abort(reason)
      await assert.rejects(() => response.text(), error => error === reason || error?.name === 'AbortError' || error?.code === 'UND_ERR_ABORTED' || error?.cause?.code === 'UND_ERR_ABORTED')
    } finally { await profile.close() }
  })
})

test('profile routes only the exact Codex POST, preserves request data, and rejects an explicit dispatcher', async () => {
  const calls = []
  const baseFetch = (...args) => { calls.push(args); return Promise.resolve({ ok: true }) }
  let closed = 0
  const agent = { dispatch() {}, async close() { closed += 1 } }
  const profile = createLongReadProfile({ baseFetch, bodyTimeoutMs: 321, agentFactory: () => agent })
  const controller = new AbortController()
  const headers = new Headers({ 'x-test': 'one' })
  try {
    await profile.fetch('https://example.invalid/backend-api/codex/responses', { method: 'POST', headers, body: 'unchanged', signal: controller.signal })
    assert.deepEqual(calls[0], ['https://example.invalid/backend-api/codex/responses', { method: 'POST', headers, body: 'unchanged', signal: controller.signal }])

    await profile.fetch('https://chatgpt.com/backend-api/codex/responses?stream=true', { method: 'POST', headers, body: 'unchanged', signal: controller.signal })
    const [input, init] = calls[1]
    assert.equal(input, 'https://chatgpt.com/backend-api/codex/responses?stream=true')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers, headers)
    assert.equal(init.body, 'unchanged')
    assert.equal(init.signal, controller.signal)
    assert.equal(typeof init.dispatcher?.dispatch, 'function')
    assert.throws(() => profile.fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', dispatcher: {} }), /LONG_READ_DISPATCHER/)
  } finally {
    await profile.close()
    await profile.close()
  }
  assert.equal(closed, 1)
})

test('dispatcher sends the configured timeout to its owned Agent', async () => {
  let seen
  const owned = createLongReadDispatcher({
    bodyTimeoutMs: 777,
    agentFactory: () => ({ dispatch(options) { seen = options; return true }, async close() {} }),
  })
  try {
    assert.equal(owned.dispatcher.dispatch({ path: '/', bodyTimeout: 300_000 }, {}), true)
    assert.equal(seen.bodyTimeout, 777)
  } finally { await owned.close() }
})

test('dispatcher passes a short connection timeout to its owned Agent and rejects invalid values', async () => {
  let seen
  const agent = { dispatch() {}, async close() {} }
  const owned = createLongReadDispatcher({
    bodyTimeoutMs: 777,
    connectTimeoutMs: 123,
    agentFactory: options => { seen = options; return agent },
  })
  try {
    assert.deepEqual(seen, { connectTimeout: 123 })
  } finally { await owned.close() }

  for (const connectTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123']) {
    assert.throws(
      () => createLongReadDispatcher({ connectTimeoutMs }),
      /connectTimeoutMs must be a positive integer/,
    )
  }
})

test('real fetch reports connection timeout once when a local TLS socket never completes its handshake', async () => {
  await withTlsHandshakeHang(async ({ url, connections }) => {
    const owned = createLongReadDispatcher({ connectTimeoutMs: 50 })
    try {
      await assert.rejects(
        () => globalThis.fetch(url, { method: 'POST', body: 'fixture', dispatcher: owned.dispatcher }),
        error => error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || error?.code === 'UND_ERR_CONNECT_TIMEOUT',
      )
    } finally { await owned.close() }
    assert.equal(connections(), 1, 'the connection timeout does not retry the POST')
  })
})
