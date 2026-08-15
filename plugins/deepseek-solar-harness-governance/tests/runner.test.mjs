import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { extractLastJsonObject, governanceArgv, runGovernance } from '../lib/runner.js'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const corePath = resolve(pluginRoot, 'runtime/governance.py')

function command(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', shell: false })
  assert.equal(result.status, 0, `${argv.join(' ')} failed: ${result.stderr}`)
}

test('extractLastJsonObject tolerates noisy gate output', () => {
  assert.deepEqual(extractLastJsonObject('gate {noise}\n{"ok":true}\n'), { ok: true })
})

test('governance argv remains an argument vector', () => {
  const argv = governanceArgv({ python: 'python3', corePath, profilePath: null }, 'plan', '/tmp/a b', ['--level', 'full'])
  assert.deepEqual(argv.slice(0, 5), ['python3', corePath, 'plan', '--project', '/tmp/a b'])
})

test('packaged core plans, verifies, and attests a real Git worktree', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-governance-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  await mkdir(join(project, '.agent-governance'))
  await writeFile(join(project, 'package.json'), '{"name":"fixture"}\n')
  await writeFile(join(project, 'source.txt'), 'initial\n')
  const profile = {
    profile_version: 1,
    name: 'dsh-plugin-fixture',
    project_markers: ['package.json'],
    instruction_sources: [],
    scope_rules: [{ scope: 'source', patterns: ['source.txt'] }],
    gates: [{
      id: 'always', label: 'always', command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.', scopes: ['always'], levels: ['quick', 'full'], timeout_seconds: 30,
    }],
  }
  await writeFile(join(project, '.agent-governance/profile.json'), `${JSON.stringify(profile, null, 2)}\n`)
  command(['git', 'init', '-q'], project)
  command(['git', 'config', 'user.email', 'test@example.com'], project)
  command(['git', 'config', 'user.name', 'Test'], project)
  command(['git', 'add', '.'], project)
  command(['git', 'commit', '-qm', 'initial'], project)
  await writeFile(join(project, 'source.txt'), 'changed\n')

  const config = {
    python: 'python3', corePath, profilePath: null, timeoutMs: 30_000,
    syncTimeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
  }
  const plan = await runGovernance(config, 'plan', project, ['--scope', 'auto', '--level', 'full'])
  assert.equal(plan.code, 0)
  assert.deepEqual(plan.payload.gates, ['always'])
  const verify = await runGovernance(config, 'verify', project, ['--scope', 'auto', '--level', 'full', '--report', '@git'])
  assert.equal(verify.code, 0)
  assert.equal(verify.payload.attestation_overall, 'ok')
  const attest = await runGovernance(config, 'attest', project, ['--report', '@git', '--require-level', 'full'])
  assert.equal(attest.code, 0)
  assert.equal(attest.payload.items.every(item => item.status === 'ok'), true)
})
