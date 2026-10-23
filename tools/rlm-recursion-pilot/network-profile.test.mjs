import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import test from 'node:test'

import { installNoReuseProfile } from './network-profile.mjs'

function fakeFetch() {
  const calls = []
  const baseFetch = (...args) => {
    calls.push(args)
    return Promise.resolve({ ok: true })
  }
  return { baseFetch, calls }
}

test('adds Connection: close only for the exact chatgpt.com hostname', async () => {
  const fake = fakeFetch()
  const originalHeaders = new Headers({ 'x-test': 'one', Connection: 'keep-alive' })
  const profile = installNoReuseProfile({ baseFetch: fake.baseFetch })
  try {
    await profile.fetch('https://chatgpt.com/v1', { headers: originalHeaders })
    assert.equal(fake.calls.length, 1)
    const [input, init] = fake.calls[0]
    assert.equal(input, 'https://chatgpt.com/v1')
    assert.notEqual(init.headers, originalHeaders)
    assert.equal(init.headers.get('x-test'), 'one')
    assert.equal(init.headers.get('connection'), 'close')
    assert.equal(originalHeaders.get('connection'), 'keep-alive')

    await profile.fetch('https://www.chatgpt.com/v1', { headers: originalHeaders })
    assert.equal(fake.calls.length, 2)
    assert.equal(fake.calls[1][0], 'https://www.chatgpt.com/v1')
    assert.equal(fake.calls[1][1].headers, originalHeaders)
  } finally {
    profile.dispose()
  }
})

test('preserves input, method, body, signal, and other request options', async () => {
  const fake = fakeFetch()
  const controller = new AbortController()
  const headers = new Headers({ 'x-request': 'yes' })
  const init = {
    method: 'POST',
    body: 'request-body',
    signal: controller.signal,
    headers,
    redirect: 'manual',
  }
  const profile = installNoReuseProfile({ baseFetch: fake.baseFetch })
  try {
    await profile.fetch('https://chatgpt.com/submit', init)
    const [input, seen] = fake.calls[0]
    assert.equal(input, 'https://chatgpt.com/submit')
    assert.equal(seen.method, init.method)
    assert.equal(seen.body, init.body)
    assert.equal(seen.signal, init.signal)
    assert.equal(seen.redirect, init.redirect)
    assert.notEqual(seen.headers, headers)
  } finally {
    profile.dispose()
  }
})

test('preserves a Request input and copies its headers without mutating it', async () => {
  const fake = fakeFetch()
  const controller = new AbortController()
  const request = new Request('https://chatgpt.com/request', {
    method: 'POST',
    body: 'request-body',
    headers: { 'x-request': 'yes' },
    signal: controller.signal,
  })
  const profile = installNoReuseProfile({ baseFetch: fake.baseFetch })
  try {
    await profile.fetch(request)
    const [input, init] = fake.calls[0]
    assert.equal(input, request)
    assert.equal(input.method, 'POST')
    assert.equal(input.signal, request.signal)
    assert.equal(input.signal.aborted, controller.signal.aborted)
    assert.equal(init.headers.get('x-request'), 'yes')
    assert.equal(init.headers.get('connection'), 'close')
    assert.equal(request.headers.get('connection'), null)
  } finally {
    profile.dispose()
  }
})

test('delegates non-target requests unchanged and performs no retry', async () => {
  const fake = fakeFetch()
  const init = { method: 'GET', headers: { 'x-test': 'one' } }
  const profile = installNoReuseProfile({ baseFetch: fake.baseFetch })
  try {
    await profile.fetch('https://api.example.com/data', init)
    assert.equal(fake.calls.length, 1)
    assert.deepEqual(fake.calls[0], ['https://api.example.com/data', init])
  } finally {
    profile.dispose()
  }
})

test('records only selected diagnostic error fields and unsubscribes on dispose', () => {
  const events = []
  const profile = installNoReuseProfile({ onDiagnostic: event => events.push(event) })
  const connectError = Object.assign(new Error('reset'), {
    code: 'ECONNRESET',
    cause: Object.assign(new Error('pipe'), { code: 'EPIPE' }),
  })
  channel('undici:client:connectError').publish({
    error: connectError,
    request: { url: 'https://chatgpt.com/private', headers: 'secret' },
    body: 'secret',
  })
  assert.deepEqual(events, [{
    channel: 'undici:client:connectError',
    error: { name: 'Error', code: 'ECONNRESET', cause: { name: 'Error', code: 'EPIPE' } },
  }])

  profile.dispose()
  profile.dispose()
  channel('undici:request:error').publish({
    error: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }),
    request: { url: 'https://chatgpt.com/private', headers: 'secret' },
  })
  assert.equal(events.length, 1)
})
