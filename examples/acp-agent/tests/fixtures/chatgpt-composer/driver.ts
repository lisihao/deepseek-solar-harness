#!/usr/bin/env node
/** Replay the assembled ChatGPT operator against a deterministic external webpage. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

const config = process.argv[2]
if (config === undefined) throw new Error('chatgpt-composer fixture requires its YAML config')
const ctx = await boot('chatgpt-composer-keyless', resolveConfigPath(config, undefined))
try {
  const operators = ctx.get('physicalOperators')
  if (operators === undefined) throw new Error('Loader did not mount physicalOperators')
  const run = await operators.start('chatgpt-web', {
    label: 'Composer initialization',
    prompt: [{ type: 'text', text: 'Return the accepted request result.' }],
    parent: { id: SessionId('keyless-composer-parent') } as unknown as Agent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  const events = await run.readEvents?.(0, 20)
  process.stdout.write(`${JSON.stringify({
    ...result,
    phases: events?.events.map(event => event.type),
  }, null, 2)}\n`)
  await run.dispose()
} finally {
  await ctx.fiber.dispose()
}
