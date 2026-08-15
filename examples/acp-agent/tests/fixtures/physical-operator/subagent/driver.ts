#!/usr/bin/env node
/** Boot and invoke the public physical-operator composition through real Loader. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('physical-operator Loader driver requires a config path')

const lifecycle = { physicalStart: 0, physicalEnd: 0, subagentStart: 0, subagentEnd: 0 }
const ctx = await boot(
  'physical-operator-loader-composition',
  resolveConfigPath(configPath, undefined),
  undefined,
  (hostCtx) => {
    hostCtx.on('physical-operator/start', () => { lifecycle.physicalStart += 1 })
    hostCtx.on('physical-operator/end', () => { lifecycle.physicalEnd += 1 })
    hostCtx.on('subagent/start', () => { lifecycle.subagentStart += 1 })
    hostCtx.on('subagent/end', () => { lifecycle.subagentEnd += 1 })
  },
)

try {
  const schema = ctx.tools.schemas().find(candidate => candidate.name === 'physical_operator')
  if (schema === undefined) throw new Error('physical_operator tool was not registered')
  const parent = ctx.agents.list()[0]
  if (parent === undefined) throw new Error('physical-operator Loader fixture has no configured parent agent')
  const list = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('loader-list'),
    name: 'physical_operator',
    arguments: { action: 'list' },
  })
  const run = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('loader-run'),
    name: 'physical_operator',
    arguments: {
      action: 'run',
      operator_id: 'physics-solver',
      description: 'solve fixture',
      prompt: 'derive period',
    },
    agent: parent,
  })
  if (list.isError || run.isError) {
    throw new Error(`physical-operator Loader calls failed: ${JSON.stringify({ list, run })}`)
  }
  const runValue = run.value as { executionId: string }
  process.stdout.write(`${JSON.stringify({
    tool: {
      name: schema.name,
      parameterNames: Object.keys(schema.parameters.properties ?? {}).sort(),
      required: schema.parameters.required,
    },
    list: list.value,
    run: {
      ...(run.value as object),
      executionId: /^[0-9a-f-]{36}$/.test(runValue.executionId) ? '<uuid>' : '<invalid>',
    },
    finalStatus: ctx.physicalOperators.status('physics-solver'),
    lifecycle,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
