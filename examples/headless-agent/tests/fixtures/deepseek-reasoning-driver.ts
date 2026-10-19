#!/usr/bin/env node
/** Two turns through the real Loader and adapter, using only the local fake endpoint. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('DeepSeek reasoning driver requires a config path')

const ctx = await boot('deepseek-reasoning-snapshot', resolveConfigPath(configPath, undefined))
try {
  for (const task of ['first', 'second']) {
    const result = await runFixtureTurn(ctx, { task })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
} finally {
  await ctx.fiber.dispose()
}
