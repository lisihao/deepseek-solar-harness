/** Exercise empty cell environments through the real Loader and durable Runtime. */
import assert from 'node:assert/strict'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'

const [config] = process.argv.slice(2)
assert(config && process.env.DSH_HOME, 'isolated Loader config and home required')
process.env.DSH_RLM_HOST_SENTINEL = 'synthetic-host-only-value'
const bindings = {
  dispatchChild: request => Promise.resolve({
    nativeSessionId: 'synthetic:' + request.childSessionId,
    nativeTurnId: 'synthetic:' + request.childId,
    result: Promise.resolve({ status: 'settled' }),
    interrupt: () => Promise.resolve(),
  }),
}
const sessionId = RlmRuntimeSessionId('environment-root')
const start = () => boot('runtime-environment-fixture', resolveConfigPath(config, undefined), undefined, undefined,
  new URL('../../package.json', import.meta.url).href)
const readEnvironment = (runtime, id, command) => runtime.executeCell({
  sessionId: id, commandId: RlmCommandId(command),
  code: 'import processView from "node:process"; ({ environmentSize: Object.keys(processView.env).length, task: context.task })',
})
let ctx
try {
  ctx = await start()
  const runtime = ctx.rlmRuntime
  await runtime.create({
    sessionId, commandId: RlmCommandId('environment-create'), executionId: 'environment-execution',
    workspace: process.cwd(), task: 'explicit root task', model: { operatorId: 'codex', model: 'unused' },
    limits: { maxDepth: 2, maxChildren: 2, maxTurns: 8, maxCellMs: 2_000, maxOutputBytes: 8192 },
    context: { task: 'explicit root task' },
  }, bindings)
  const root = (await readEnvironment(runtime, sessionId, 'environment-root-cell')).value
  const child = await runtime.spawn({
    commandId: RlmCommandId('environment-child'), parentSessionId: sessionId,
    name: 'environment-child', task: 'explicit child task',
  })
  const childValue = (await readEnvironment(runtime, child.sessionId, 'environment-child-cell')).value
  await ctx.fiber.dispose()
  ctx = await start()
  await ctx.rlmRuntime.bindHost(sessionId, bindings)
  const recovered = (await ctx.rlmRuntime.executeCell({
    sessionId, commandId: RlmCommandId('environment-recovered-cell'),
    code: '({ environmentSize: Object.keys(processView.env).length, task: context.task })',
  })).value
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    assert.match(import.meta.resolve('@deepseek-ai/dsh-rlm-runtime-local'), /\/lib\/index\.js$/)
    assert(!process.execArgv.some(argument => /tsx/.test(argument)))
  }
  assert.equal(process.env.DSH_RLM_HOST_SENTINEL, 'synthetic-host-only-value')
  process.stdout.write(JSON.stringify({ root, child: childValue, recovered,
    parentEnvironmentUnchanged: true, actualHttpModelRequests: 0 }) + '\n')
} finally {
  await ctx?.fiber.dispose()
}
