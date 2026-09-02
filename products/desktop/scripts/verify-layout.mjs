import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const solarRoot = resolve(root, '../..')
const readJson = (base, path) => JSON.parse(readFileSync(resolve(base, path), 'utf8'))
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const fail = message => { throw new Error(`verify-layout: ${message}`) }

const workspace = readJson(root, 'package.json')
const upstream = readJson(root, 'upstream.json')
const plugin = readJson(root, 'dsh-plugin-desktop/package.json')
const solarWorkspace = readJson(solarRoot, 'package.json')
const noteDirectory = '.agents/notes/implemented/process'
const noteName = '2026-08-15-pinned-upstream-and-isolated-yarn-workspace'
const notePaths = [`${noteDirectory}/${noteName}.md`, `${noteDirectory}/${noteName}.zh.md`]
const noteRecordPath = `${noteDirectory}/${noteName}.i18n.yaml`
const sealedDshExtensions = new Set([
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-archify',
  '@deepseek-ai/dsh-browser',
  '@deepseek-ai/dsh-browser-ego-lite',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-physical-operator',
  '@deepseek-ai/dsh-physical-operator-resident',
  '@deepseek-ai/dsh-resident-operator',
  '@deepseek-ai/dsh-resident-operator-local',
  '@deepseek-ai/dsh-resident-operators',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-tool-physical-operator',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-remote-modules',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-host-remote-auth',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-tool-markdown',
  '@deepseek-ai/dsh-tool-regex',
  '@deepseek-ai/dsh-tool-stat',
  '@deepseek-ai/dsh-tool-time',
  '@deepseek-ai/dsh-intent-compiler',
  '@deepseek-ai/dsh-context-compiler',
  '@deepseek-ai/dsh-capability-capsule',
  '@deepseek-ai/dsh-continual-harness',
  '@deepseek-ai/dsh-continual-harness-local',
  '@deepseek-ai/dsh-debate',
  '@deepseek-ai/dsh-debate-local',
  '@deepseek-ai/dsh-debate-orchestration',
  '@deepseek-ai/dsh-ego-lite-browser',
  '@deepseek-ai/dsh-tool-debate',
  '@deepseek-ai/dsh-tool-browser',
  '@deepseek-ai/dsh-ui-debate',
  '@deepseek-ai/dsh-model-allocation',
  '@deepseek-ai/dsh-model-allocation-local',
  '@deepseek-ai/dsh-model-worker',
  '@deepseek-ai/dsh-model-worker-deepseek',
  '@deepseek-ai/dsh-rlm-runtime',
  '@deepseek-ai/dsh-rlm-runtime-local',
  '@deepseek-ai/dsh-rlm-strategy',
  '@deepseek-ai/dsh-rlm-strategy-local',
  '@deepseek-ai/dsh-orchestration',
  '@deepseek-ai/dsh-orchestration-local',
  '@deepseek-ai/dsh-tool-orchestration',
  '@deepseek-ai/dsh-ui-orchestration',
  '@deepseek-ai/dsh-ui-physical-operator',
  '@deepseek-ai/dsh-orchestrations',
])

if (workspace.packageManager !== 'yarn@4.18.0') {
  fail('the Desktop product workspace must pin yarn@4.18.0')
}
if (JSON.stringify(workspace.workspaces) !== JSON.stringify(['dsh-plugin-desktop'])) {
  fail('the Desktop Yarn workspace must contain only dsh-plugin-desktop')
}
if (plugin.packageManager !== undefined) {
  fail('dsh-plugin-desktop must inherit the Desktop Yarn release')
}
const claudePath = resolve(root, 'CLAUDE.md')
if (!lstatSync(claudePath).isSymbolicLink() || readlinkSync(claudePath) !== 'AGENTS.md') {
  fail('CLAUDE.md must link to the Desktop AGENTS.md')
}
for (const legacyFile of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'dsh-plugin-desktop/pnpm-lock.yaml',
  'dsh-plugin-desktop/pnpm-workspace.yaml',
]) {
  if (existsSync(resolve(root, legacyFile))) fail(`${legacyFile} must not exist inside the Desktop workspace`)
}
for (const removedNestedSource of ['.gitmodules', 'deepseek-harness']) {
  if (existsSync(resolve(root, removedNestedSource))) {
    fail(`${removedNestedSource} must not reintroduce a nested Harness checkout`)
  }
}
if (typeof solarWorkspace.packageManager !== 'string' || !solarWorkspace.packageManager.startsWith('pnpm@')) {
  fail('the Solar monorepo root must retain its pnpm package manager')
}
for (const required of [
  'AGENTS.md',
  'pnpm-lock.yaml',
  'apps/cli/src/bin.ts',
  'docs/architecture/adr-002-monorepo.md',
]) {
  if (!existsSync(resolve(solarRoot, required))) fail(`Solar monorepo root is missing ${required}`)
}
if (run('git', ['rev-parse', '--show-toplevel'], solarRoot) !== solarRoot) {
  fail('products/desktop must belong to the Solar monorepo Git root')
}

for (const [owner, manifest] of [['root', workspace], ['plugin', plugin]]) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== 'string') continue
      if (/^(?:workspace|portal|link):/u.test(range)
        || (range.startsWith('file:') && range.includes('deepseek-harness'))) {
        fail(`${owner} ${field}.${name} bypasses the accepted Desktop package boundary`)
      }
    }
  }
}

for (const name of Object.keys(plugin.dependencies).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) {
  const range = plugin.dependencies[name]
  if (sealedDshExtensions.has(name)) {
    if (!range.startsWith('file:vendor/dsh-packages/') || !range.endsWith('.tgz')) {
      fail(`${name} must use a sealed Desktop vendor tarball during migration`)
    }
  } else if (range !== upstream.runtimePackageVersion) {
    fail(`${name} must use the recorded DSH runtime package family during migration`)
  }
}

const lockText = readFileSync(resolve(root, 'yarn.lock'), 'utf8')
const unexpectedRuntimeVersions = new Set()
for (const match of lockText.matchAll(/resolution: "@deepseek-ai\/dsh(?:-[^"@]+)?@npm:([^"#]+)"/gu)) {
  if (match[1] !== upstream.runtimePackageVersion) unexpectedRuntimeVersions.add(match[1])
}
if (unexpectedRuntimeVersions.size > 0) {
  fail(`yarn.lock mixes DSH runtime package families: ${[...unexpectedRuntimeVersions].sort().join(', ')}`)
}

const noteRecord = readFileSync(resolve(root, noteRecordPath), 'utf8')
for (const notePath of notePaths) {
  const expected = run('git', ['hash-object', '--', notePath])
  const recordLine = `${basename(notePath)}: ${expected}`
  if (!noteRecord.split('\n').includes(recordLine)) {
    fail(`${noteRecordPath} is stale for ${notePath}`)
  }
}

process.stdout.write(`verify-layout: Desktop Yarn workspace and Solar pnpm root are consistent; every registry DSH package is pinned to runtime family ${upstream.runtimePackageVersion}\n`)
