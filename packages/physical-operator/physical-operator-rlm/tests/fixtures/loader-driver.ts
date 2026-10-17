/** Drive the real runnable standalone example; external transports are keyless fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { OrchestrationArtifactRef } from '@deepseek-ai/dsh-orchestration'
import { materializeOperatorContextEnvelopeNative, parseOperatorContextEnvelope, renderOperatorContextEnvelopeText } from '@deepseek-ai/dsh-system-prompt'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { state } from './loader-transports.ts'

const config = process.argv[2]
if (config === undefined) throw new Error('expected the standalone example config')
let ctx: Context | undefined
try {
  ctx = await boot('standalone-loader-fixture', resolveConfigPath(config, undefined), undefined, undefined, new URL('../../package.json', import.meta.url).href)
  const failures: unknown[] = []
  let loggedOuterEnvelope: unknown
  const result = await runFixtureTurn(ctx, {
    task: 'Analyze the complete two-part fixture input.',
    onEvent: (_sessionId, event) => {
      if (event.type === 'physical-operator/context-envelope') loggedOuterEnvelope = event.data.envelope
      if (/error|failed|tool-result|assistant\/message/.test(event.type)) failures.push(event)
    },
  })
  const runs = state.daemon!.store.listRuns()
  if (runs.length !== 1 || runs[0]!.snapshot.state !== 'completed') {
    throw new Error('expected one completed original business run: ' + JSON.stringify({
      runs: runs.map(run => run.snapshot), result, outerRequests: state.outerRequests,
      apiRequests: state.apiRequests, failures,
    }))
  }
  if (state.outerRequests !== 2) throw new Error('expected one real physical_operator tool round trip')
  const command = state.daemon!.store.standaloneCommandForRun(runs[0]!.snapshot.runId)
  const input = command?.standaloneRequest?.input
  if (input === null || typeof input !== 'object' || !('contextEnvelope' in input)
    || input.contextEnvelope === null || typeof input.contextEnvelope !== 'object'
    || !('systemText' in input.contextEnvelope) || typeof input.contextEnvelope.systemText !== 'string') {
    throw new Error('full logged outer context was not retained')
  }
  if (command === undefined) throw new Error('missing original standalone command')
  const outerEnvelope = parseOperatorContextEnvelope(input.contextEnvelope)
  assert.deepEqual(loggedOuterEnvelope, input.contextEnvelope, 'outer session log must retain every frozen envelope field')
  const rootEvent = state.daemon!.store.readEvents(String(runs[0]!.snapshot.runId), 0, 500).events.find(event =>
    event.type === 'operator.context.received' && String(event.data.commandId).endsWith(':rlm:root'))
  if (typeof rootEvent?.data.ref !== 'string') throw new Error('missing root model context evidence')
  const retained = state.daemon!.store.readArtifact(OrchestrationArtifactRef(rootEvent.data.ref))
  if (retained === null || typeof retained !== 'object' || !('kind' in retained)
    || retained.kind !== 'operator-context-envelope' || !('envelopeJson' in retained)
    || typeof retained.envelopeJson !== 'string') throw new Error('missing exact logged root envelope representation')
  const rootEnvelope = parseOperatorContextEnvelope(JSON.parse(retained.envelopeJson))
  assert.equal(rootEvent.data.digest, rootEnvelope.digest, 'logged materialization digest must match the retained root input')
  assert(rootEnvelope.task.some(block => block.type === 'text' && block.text === renderOperatorContextEnvelopeText(outerEnvelope)),
    'the complete frozen outer envelope must reach the real root task without omitted sections')
  if (state.driver === 'api') {
    assert(state.firstApiTextBlocks.includes(renderOperatorContextEnvelopeText(rootEnvelope)),
      'the complete logged root envelope must equal an actual first API request text block')
  } else {
    const expected = materializeOperatorContextEnvelopeNative(rootEnvelope)
    assert.deepEqual(state.residentMaterialized, { prompt: expected.prompt, systemPrompt: expected.systemPrompt },
      'every native prompt block and the complete system prompt must match the logged root envelope')
  }
  const response = command.response
  if (response === null || typeof response !== 'object' || !('output' in response)
    || !Array.isArray(response.output)) throw new Error('missing settled wrapper result')
  state.wrapperUsageAbsent = !('usage' in response)
  if (state.driver === 'api' && state.apiRequests !== 2) throw new Error('expected two physical API attempts through the real DeepSeek tool loop')
  if (state.driver === 'codex' && state.residentRequests !== 1) throw new Error('expected one fake native Resident request')
  process.stdout.write(JSON.stringify({
    driver: state.driver,
    task: 'Analyze the complete two-part fixture input.',
    output: result.output,
    originalBusinessRuns: runs.length,
    fullContextRetained: true,
    apiPhysicalRequests: state.apiRequests,
    residentPhysicalRequests: state.residentRequests,
    wrapperUsageAbsent: state.wrapperUsageAbsent,
    innerToolResultObserved: state.innerToolResultObserved,
  }) + '\n')
} finally {
  await ctx?.fiber.dispose()
}
