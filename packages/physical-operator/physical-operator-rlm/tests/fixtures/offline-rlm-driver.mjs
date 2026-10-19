/** Run the keyless Loader composition in source or plain-Node built mode. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { cellProxy, runTrial } from '../../../../orchestration/orchestration-local/tests/fixtures/offline-rlm/trial.mjs'

const config = process.argv[2]
assert(config, 'a real Loader config is required')
assert(process.env.DSH_HOME, 'the scenario requires an isolated DSH_HOME')
const home = process.env.DSH_HOME
await mkdir(home, { recursive: true })
const text = 'UTF8-BEGIN-起点\n' + 'synthetic middle facts only. '.repeat(1500) + '\nUTF8-END-终点'
const corpusPath = join(home, 'corpus.txt')
await writeFile(corpusPath, text)
const corpus = { text, path: corpusPath, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
let ctx
const bootFixture = () => boot('offline-rlm-fixture', resolveConfigPath(config, undefined), undefined, undefined,
  new URL('../../../../../examples/package.json', import.meta.url).href)
try {
  ctx = await bootFixture()
  const pairs = []
  for (const spawnMode of ['none', 'root-only', 'recursive']) {
    const rows = []
    for (const placement of ['full', 'external']) {
      rows.push(await runTrial(ctx, join(home, placement + '-' + spawnMode), corpus, placement, spawnMode))
    }
    assert.deepEqual(rows[0].parameters, rows[1].parameters)
    assert.deepEqual(rows[0].firstPromptContent.slice(0, 1), rows[1].firstPromptContent)
    assert.deepEqual(rows[0].cellCodes, rows[1].cellCodes)
    assert.deepEqual(rows[0].perSendParameters, rows[1].perSendParameters)
    // Only generated Runtime owner/command identities are excluded; full raw tool messages remain in evidence.json.
    assert.deepEqual(rows[0].toolResults, rows[1].toolResults)
    assert.equal(rows[0].actualSends, rows[1].actualSends)
    assert.equal(rows[0].cells, rows[1].cells)
    assert.equal(rows[0].firstRequestHasFullCorpus, true)
    assert.equal(rows[1].firstRequestHasFullCorpus, false)
    assert.equal(rows[0].contextHasFullCorpus, true)
    assert.equal(rows[1].contextHasFullCorpus, false)
    pairs.push({ spawnMode, actualSends: rows[0].actualSends, cells: rows[0].cells,
      descendants: rows[0].descendants, completeUsage: rows.every(row => row.completeUsage),
      fullRetained: true, externalReferenceOnly: true, actualRequestPlacementVerified: true, sameExecutionParameters: true })
  }
  const negatives = []
  for (const scenario of ['strict', 'attempt-cap', 'output-cap', 'cell-cap', 'known-unknown', 'over-output', 'late-cell']) {
    const row = await runTrial(ctx, join(home, scenario), corpus, 'external', scenario === 'cell-cap' ? 'root-only' : 'none', scenario)
    negatives.push({ scenario, actualSends: row.actualSends, completeUsage: row.completeUsage,
      unknown: row.unknown, lateCellRetained: row.lateCellRetained })
  }
  await assert.rejects(() => runTrial(ctx, join(home, 'external-none'), corpus, 'external', 'none'), { code: 'EEXIST' })
  const proxyHome = join(home, 'proxy-negative')
  await mkdir(proxyHome)
  const sessionId = 'proxy-negative'
  await ctx.rlmRuntime.create({ sessionId, commandId: 'proxy-negative:create', executionId: 'proxy-negative',
    workspace: proxyHome, task: 'test cell admission', model: { operatorId: 'deepseek-api', model: 'scripted-offline-model' },
    limits: { maxDepth: 1, maxChildren: 1, maxTurns: 4, maxCellMs: 10000, maxOutputBytes: 8192 },
    childSpawnPolicy: { version: 1, mode: 'none', maxTotalChildren: 0 } },
  { dispatchChild: () => { throw new Error('none cannot dispatch') } })
  const proxy = await cellProxy(ctx.rlmRuntime, proxyHome, new AbortController().signal, 1)
  try {
    await proxy.bridge(sessionId)
    const params = { session_id: String(sessionId), command_id: 'stable-command', tool: 'typescript_repl',
      arguments: { code: "await new Promise(resolve => setTimeout(resolve, 30)); console.log('ONCE');" } }
    const first = proxy.handle('tool.call', params)
    assert.equal(proxy.handle('tool.call', structuredClone(params)), first)
    assert.throws(() => proxy.handle('tool.call', { ...params, arguments: { code: '2' } }), /identity conflict/)
    assert.throws(() => proxy.handle('tool.call', { ...params, session_id: 'unregistered' }), /outside this trial/)
    assert.throws(() => proxy.handle('tool.call', { ...params, command_id: 'second' }), /cell limit/)
    await first
    assert.equal(proxy.handle('tool.call', params), first)
    assert.equal(proxy.forwarded, 1)
  } finally { await proxy.close() }
  await ctx.fiber.dispose()
  ctx = await bootFixture()
  // Read the reopened Runtime's actual context through its cell API, not only the old JSON file.
  const reopened = await ctx.rlmRuntime.executeCell({
    sessionId: 'offline-external-none-normal',
    commandId: 'post-reopen-context', code: 'JSON.parse(JSON.stringify(context))',
  })
  assert.equal(reopened.value.corpus.sha256, corpus.sha256)
  assert.equal('rawCorpus' in reopened.value, false)
  assert.equal(createHash('sha256').update(await readFile(corpusPath)).digest('hex'), corpus.sha256)
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    assert.match(import.meta.resolve('@deepseek-ai/dsh-orchestration-local'), /\/lib\/index\.js$/)
    assert(!process.execArgv.some(arg => /tsx/.test(arg)))
  }
  process.stdout.write(JSON.stringify({ pairs, negatives, proxyIdentityAndCellLimitVerified: true,
    consumerResumeRefused: true, runtimeContextReopenVerified: true, corpusOriginalBytesVerified: true,
    productionTokenBoundProven: false, oracleIsolationProven: false, paidLaunchAllowed: false, experimentReady: false }) + '\n')
} finally { await ctx?.fiber.dispose() }
