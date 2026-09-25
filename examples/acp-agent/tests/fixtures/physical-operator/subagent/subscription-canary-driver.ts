#!/usr/bin/env node
/** Invoke one native-account product through Loader -> tool -> physical operator -> subagent. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
const operatorId = process.argv[3]
const expectedMarker = process.argv[4]
if (configPath === undefined || operatorId === undefined || expectedMarker === undefined) {
  throw new Error('subscription canary requires <config> <operator-id> <expected-marker>')
}
if (!/^[A-Z0-9_:-]+$/.test(expectedMarker)) {
  throw new Error('subscription canary marker must use only A-Z, digits, underscore, colon, or hyphen')
}

const providerName = operatorId === 'physics-codex'
  ? 'codex'
  : operatorId === 'physics-claude-code'
    ? 'claude-code'
    : undefined
if (providerName === undefined) throw new Error(`unsupported subscription canary operator: ${operatorId}`)

const ctx = await boot(
  'physical-operator-subscription-canary',
  resolveConfigPath(configPath, undefined),
)

try {
  const authentication = ctx.subagents.getProvider(providerName)?.authentication?.mode
  if (authentication !== 'native-subscription') {
    throw new Error(`${providerName} did not attest native-subscription authentication`)
  }
  const parent = ctx.agents.list()[0]
  if (parent === undefined) throw new Error('subscription canary has no configured parent agent')
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`subscription-canary-${providerName}`),
    name: 'physical_operator',
    arguments: {
      action: 'run',
      operator_id: operatorId,
      description: 'native subscription canary',
      prompt: `Return exactly this marker and nothing else: ${expectedMarker}. Do not use tools.`,
    },
    agent: parent,
  })
  if (result.isError) throw new Error(`subscription canary tool failed: ${JSON.stringify(result.value)}`)
  const value = result.value as {
    kind?: string
    operatorId?: string
    output?: Array<{ type?: string; text?: string }>
  }
  const output = value.output?.map(block => block.type === 'text' ? block.text ?? '' : '').join('') ?? ''
  if (value.kind !== 'run' || value.operatorId !== operatorId || !output.includes(expectedMarker)) {
    throw new Error('subscription canary result did not contain the expected bounded marker')
  }
  process.stdout.write(`${JSON.stringify({
    operatorId,
    authentication,
    marker: expectedMarker,
    outputMatched: true,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
