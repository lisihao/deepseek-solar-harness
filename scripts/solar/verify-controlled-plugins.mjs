#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')

const checks = [
  ['aegis', 'node', ['extensions/dsh/verify.mjs']],
  ['better-sidebar build', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'build']],
  ['better-sidebar typecheck', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'typecheck']],
  ['better-sidebar tests', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'test']],
  ['codegraph tests', 'npm', ['test']],
  ['codegraph package', 'npm', ['pack', '--dry-run']],
  ['genui', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'check']],
  ['llm-fallbacks typecheck', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'typecheck']],
  ['llm-fallbacks tests', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'test']],
  ['llm-fallbacks build', 'corepack', ['pnpm', '--ignore-workspace', 'run', 'build']],
  ['mnemon', 'corepack', ['pnpm', '--ignore-workspace', '--config.verify-deps-before-run=warn', 'run', 'verify']],
  ['plugin-check', 'npm', ['run', 'check']],
  ['tool-markdown', 'npm', ['run', 'check']],
  ['tool-regex', 'npm', ['run', 'check']],
  ['tool-stat', 'npm', ['run', 'check']],
  ['tool-time', 'npm', ['run', 'check']],
]

for (const [label, command, args] of checks) {
  const pluginId = label.split(' ')[0]
  console.log(`\n[controlled-plugin] ${label}`)
  const result = spawnSync(command, args, {
    cwd: resolve(projectRoot, 'plugins/managed', pluginId),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`\n[controlled-plugin] ok (${checks.length} native checks)`)
