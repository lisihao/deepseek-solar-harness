#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(import.meta.dirname, '../..')

export const CONTROLLED_PLUGIN_INSTALLS = [
  ...['better-sidebar', 'genui', 'llm-fallbacks', 'mnemon'].map(plugin => ({
    plugin,
    command: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile'],
  })),
  ...['plugin-check', 'tool-markdown', 'tool-regex', 'tool-stat', 'tool-time'].map(plugin => ({
    plugin,
    command: 'npm',
    args: ['ci', '--no-audit', '--fund=false'],
  })),
]

export function installControlledPluginDependencies() {
  for (const { plugin, command, args } of CONTROLLED_PLUGIN_INSTALLS) {
    console.log(`\n[controlled-plugin-install] ${plugin}`)
    const result = spawnSync(command, args, {
      cwd: resolve(projectRoot, 'plugins/managed', plugin),
      env: process.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) installControlledPluginDependencies()
