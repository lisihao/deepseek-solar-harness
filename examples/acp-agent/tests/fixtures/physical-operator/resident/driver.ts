#!/usr/bin/env node
/** Invoke both lifetimes through Loader, tool, and the dual-mode Provider. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('resident Loader driver requires a config path')

const ctx = await boot('resident-operator-loader-composition', resolveConfigPath(configPath, undefined))
try {
  const parent = ctx.agents.list()[0]
  if (parent === undefined) throw new Error('resident Loader fixture has no parent agent')
  const execute = (callId: string, mode: 'ephemeral' | 'resident') => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name: 'physical_operator',
    arguments: {
      action: 'run',
      operator_id: 'physics-solver',
      description: `${mode} fixture`,
      prompt: `derive period ${callId}`,
      mode,
    },
    agent: parent,
  })
  const listed = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('resident-list'),
    name: 'physical_operator',
    arguments: { action: 'list' },
  })
  const ephemeral = await execute('one', 'ephemeral')
  const residentOne = await execute('two', 'resident')
  const residentTwo = await execute('three', 'resident')
  if (listed.isError || ephemeral.isError || residentOne.isError || residentTwo.isError) {
    throw new Error(`resident Loader execution failed: ${JSON.stringify({ listed, ephemeral, residentOne, residentTwo })}`)
  }
  const normalized = (value: unknown): unknown => {
    const record = value as Record<string, unknown>
    return { ...record, executionId: '<uuid>' }
  }
  process.stdout.write(`${JSON.stringify({
    list: listed.value,
    ephemeral: normalized(ephemeral.value),
    residentOne: normalized(residentOne.value),
    residentTwo: normalized(residentTwo.value),
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
