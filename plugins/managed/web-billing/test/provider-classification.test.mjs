import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

function counts(overrides = {}) {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    costNominal: 0,
    costNominalUsd: 0,
    savings: 0,
    savingsUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    ...overrides,
  }
}

function config(persistPath) {
  return {
    currency: 'CNY',
    symbol: '¥',
    symbolUsd: '$',
    displayCurrency: 'auto',
    timezone: 'Asia/Shanghai',
    peakWindows: [[9, 12], [14, 18]],
    officialPricing: 'auto',
    prices: {},
    usdPrices: {},
    localProviders: [],
    localCostPerM: 0,
    nonBillableProviders: ['dsh-physical-operator', 'dsh-debate-host'],
    policyOverrides: [],
    persistPath,
    maxRecent: 20_000,
    maxMessagesPerSession: 2_000,
    loopbackOnly: true,
    balance: { enabled: false },
  }
}

function harness(configValue) {
  let sessionListener
  let billingRoute
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined,
    on: (name, listener) => {
      if (name === 'session/event') sessionListener = listener
    },
    effect: effect => effect(),
    webServer: {
      register: route => {
        billingRoute = route
        return () => {}
      },
    },
  }
  apply(ctx, configValue)
  return {
    emit(sessionId, event) {
      sessionListener({ id: sessionId }, event)
    },
    async state() {
      let body = ''
      const req = { method: 'GET', url: '/billing/state', socket: { remoteAddress: '127.0.0.1' } }
      const res = {
        writeHead() {},
        end(value = '') { body = value },
      }
      await billingRoute.handler(req, res)
      return JSON.parse(body)
    },
  }
}

function assistantEvent({ seq, provider, model, inputTokens, outputTokens }) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.parse('2026-09-04T10:00:00+08:00'),
    data: {
      usage: { inputTokens, cacheReadTokens: 0, outputTokens },
      message: {
        id: `message-${seq}`,
        source: { kind: 'model', provider, model },
      },
    },
  }
}

test('subscription and aggregate hosts do not enter the DeepSeek API billing ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-billing-provider-'))
  const runtime = harness(config(join(root, 'ledger.json')))

  runtime.emit('session-a', assistantEvent({
    seq: 1,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    inputTokens: 1_000,
    outputTokens: 100,
  }))
  runtime.emit('session-a', assistantEvent({
    seq: 2,
    provider: 'dsh-debate-host',
    model: 'debate',
    inputTokens: 98_181,
    outputTokens: 8_547,
  }))
  runtime.emit('session-a', assistantEvent({
    seq: 3,
    provider: 'dsh-physical-operator',
    model: 'codex',
    inputTokens: 31_690,
    outputTokens: 58,
  }))

  const state = await runtime.state()
  assert.equal(state.totals.calls, 1)
  assert.equal(state.totals.inputTokens, 1_000)
  assert.equal(state.totals.outputTokens, 100)
  assert.deepEqual(Object.keys(state.byModel), ['deepseek-v4-flash'])
})

test('repricing removes historical aggregate-host charges from an existing ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-billing-reprice-'))
  const persistPath = join(root, 'ledger.json')
  const deepseek = {
    ...counts({ cost: 0.0019, costUsd: 0.000278 }),
    sessionId: 'session-a',
    messageId: 'deepseek-message',
    time: Date.parse('2026-09-04T10:00:00+08:00'),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    inputTokens: 1_000,
    cacheReadTokens: 0,
    outputTokens: 100,
  }
  const debate = {
    sessionId: 'session-a',
    messageId: 'debate-message',
    time: Date.parse('2026-09-04T10:01:00+08:00'),
    provider: 'dsh-debate-host',
    model: 'debate',
    inputTokens: 98_181,
    cacheReadTokens: 6_656,
    outputTokens: 8_547,
    cost: 0.1860658,
    costUsd: 0.027287432,
    costNominal: 0.1860658,
    costNominalUsd: 0.027287432,
    savings: 0,
    savingsUsd: 0,
  }
  await writeFile(persistPath, JSON.stringify({
    version: 2,
    pricingHash: 'old-classification',
    totals: counts({ calls: 2, cost: deepseek.cost + debate.cost, inputTokens: 99_181, outputTokens: 8_647 }),
    byModel: {},
    byDay: {},
    sessions: {
      'session-a': {
        ...counts({ calls: 2, cost: deepseek.cost + debate.cost, inputTokens: 99_181, outputTokens: 8_647 }),
        messages: { 'deepseek-message': deepseek, 'debate-message': debate },
      },
    },
    recent: [deepseek, debate],
  }))

  const runtime = harness(config(persistPath))
  const state = await runtime.state()
  assert.equal(state.totals.calls, 1)
  assert.equal(state.totals.inputTokens, 1_000)
  assert.equal(state.totals.outputTokens, 100)
  assert.deepEqual(Object.keys(state.byModel), ['deepseek-v4-flash'])
})
