#!/usr/bin/env node
/** Inspect physical-operator mappings to real product providers without starting them. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('physical-operator product driver requires a config path')

let subagentStarts = 0
let physicalStarts = 0
const ctx = await boot(
  'physical-operator-product-composition',
  resolveConfigPath(configPath, undefined),
  undefined,
  (hostCtx) => {
    hostCtx.on('subagent/start', () => { subagentStarts += 1 })
    hostCtx.on('physical-operator/start', () => { physicalStarts += 1 })
  },
)

try {
  const tool = ctx.tools.schemas().find(candidate => candidate.name === 'physical_operator')
  if (tool === undefined) throw new Error('physical_operator tool was not registered')
  process.stdout.write(`${JSON.stringify({
    providers: ctx.subagents.list().filter(name => name === 'codex' || name === 'claude-code'),
    operators: ctx.physicalOperators.list().map(operator => ({
      id: operator.id,
      state: operator.state,
      active: operator.active,
      maxConcurrency: operator.maxConcurrency,
    })),
    tool: tool.name,
    starts: { subagent: subagentStarts, physicalOperator: physicalStarts },
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
