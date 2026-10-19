/** Actual source Worker/QuickJS assembly: all eight diagnostic rows refuse before local HTTP. Not a real model study. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'
import { runStudy8 } from '../../../packages/orchestration/orchestration-local/tests/fixtures/study8/runner.mjs'

const [config] = process.argv.slice(2)
assert(config && process.env.DSH_HOME && process.env.DSH_STUDY8_PREP)
const prep = process.env.DSH_STUDY8_PREP, home = process.env.DSH_HOME
let arrivals = 0
const server = createServer((_request, response) => { arrivals++; response.writeHead(500); response.end('unexpected dispatch') })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
process.env.DSH_HTTP_TEST_URL = 'http://127.0.0.1:' + server.address().port
process.env.DSH_HTTP_TEST_AUTH = 'synthetic-not-a-provider-key'
const evidence = 'a'.repeat(64)
let ctx
try {
  ctx = await boot('study8-source-refusal', resolveConfigPath(config, undefined), undefined, undefined, new URL('../../package.json', import.meta.url).href)
  const options = { outputRoot: join(home, 'study8-keyless-refusal'),
    inputs: { cases: join(prep, 'rlm-pilot-development-inputs-20261018/frozen-development/runner-inputs/cases.json'),
      freeze: join(prep, 'rlm-pilot-development-inputs-20261018/frozen-development/freeze.json'),
      schedule: join(prep, 'R73-recursion-study8-preparation-20261018/preparation.json') },
    route: { provider: 'local-http-fixture', model: 'synthetic-http-model', workerId: 'deepseek-api', endpoint: process.env.DSH_HTTP_TEST_URL,
      reasoningEffort: 'high', thinking: 'enabled', evidenceSHA256: evidence },
    bound: { evidenceSHA256: evidence, includesServerTemplate: true, includesReasoningOutput: true,
      forRequest: facts => ({ model: facts.model, bodySha256: facts.bodySha256, evidenceSHA256: evidence,
        inputTokensUpperBound: 1000, reasoningInclusiveOutputUpperBound: 4096 }) },
    quote: { currency: 'synthetic-only', observedAt: '2026-10-19T00:00:00Z', evidenceSHA256: evidence,
      inputPerMillionUpper: 1, outputPerMillionUpper: 2, noAdditionalRequestOrServerToolFees: true },
    admissionBinding: { evidenceSHA256: evidence, verifyRoute: async () => true,
      bind: ledger => ({ ledger, admit: (label, facts) => ledger.admission(label)(facts) }) } }
  const result = await runStudy8(ctx, options)
  assert.equal(result.rows.length, 8)
  assert(result.rows.every(row => row.status === 'refused'))
  assert.equal(arrivals, 0)
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
  assert.equal(report.ledger.state.attempts.length, 8)
  assert(report.ledger.state.attempts.every(item => item.state === 'refused' && item.refusal === 'input-bound-unproven'))
  const first = result.rows[0]
  await assert.rejects(ctx.rlmRuntime.spawn({ commandId: RlmCommandId('late-diagnostic-child'),
    parentSessionId: RlmRuntimeSessionId(first.executionId), name: 'late-child', task: 'must never reach Worker' }), /trial closed/)
  await assert.rejects(runStudy8(ctx, options), error => error.code === 'EEXIST')
  assert.equal(arrivals, 0)
  console.log(JSON.stringify({ diagnosticOnly: true, frozenRowsRetained: 8, refusedBeforeHTTP: 8,
    localHttpSends: 0, externalModelRequests: 0, lateChildRefused: true, duplicateClaimRefused: true }))
} finally { await ctx?.fiber.dispose(); await new Promise(resolve => server.close(resolve)) }
