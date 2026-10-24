import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  assertApplicationsStopped,
  configureDevelopmentProfile,
  findLiveApplicationProcesses,
  hostModulesPathForApp,
  hostModulesPathCandidatesForApp,
  launcherPathForApp,
} from '../configure-development-profile.mjs'

const execFile = promisify(execFileCallback)
const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const SCRIPT = join(ROOT, 'tools', 'configure-development-profile.mjs')

const jevEntries = [
  'jev',
  'jev-selection',
  'jev-supervision',
  'jev-instructions',
  'jev-shared-findings',
  'jev-interjection-routing',
  'jev-output-admission',
  'jev-workspace-approval',
  'jev-stage-navigation',
].map((id) => ({ id, disabled: true }))

function normalPatch() {
  return JSON.stringify([
    { id: 'unrelated', disabled: false, credential: 'SECRET_PLACEHOLDER', config: { keep: true } },
    ...jevEntries,
    { id: 'solar-bench', name: '@lisihao/dsh-solar-bench', config: { keep: 'bench-setting', launcher: ['/old/app/dsh'] } },
  ], null, 2) + '\n'
}

async function makeFixture({ patch = normalPatch(), asar = false } = {}) {
  const root = await mkdtemp(join(ROOT, '.development-profile-fixture-'))
  const profile = join(root, 'profile')
  const app = join(root, 'DeepSeek Harness.app')
  const launcher = launcherPathForApp(app)
  const hostmodules = asar ? hostModulesPathCandidatesForApp(app)[1] : hostModulesPathForApp(app)
  await mkdir(profile, { recursive: true })
  await mkdir(join(profile, 'node_modules', '@lisihao', 'dsh-solar-bench'), { recursive: true })
  await symlink(join(ROOT, 'node_modules', '.pnpm', 'node_modules', 'yaml'), join(profile, 'node_modules', 'yaml'), 'dir')
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true })
  if (asar) await writeFile(join(app, 'Contents', 'Resources', 'app.asar'), 'ASAR fixture marker\n', 'utf8')
  else await mkdir(hostmodules, { recursive: true })
  await mkdir(resolve(launcher, '..'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true }), 'utf8')
  await writeFile(join(profile, 'node_modules', '@lisihao', 'dsh-solar-bench', 'package.json'), JSON.stringify({ name: '@lisihao/dsh-solar-bench', version: '0.1.0-dev.0' }), 'utf8')
  await writeFile(launcher, '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(profile, 'cordis.patch.yml'), patch, 'utf8')
  return { root, profile, app, launcher, hostmodules, patchPath: join(profile, 'cordis.patch.yml') }
}

async function cleanup(fixture) {
  await rm(fixture.root, { recursive: true, force: true })
}

async function runCli(fixture, extra = []) {
  try {
    const result = await execFile(process.execPath, [SCRIPT, '--profile', fixture.profile, '--app', fixture.app, ...extra], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

function parseOutput(stdout) {
  assert.equal(stdout.trim().split('\n').length, 1)
  const value = JSON.parse(stdout)
  assert.deepEqual(Object.keys(value), ['changed', 'launcher', 'hostmodules', 'backup'])
  return value
}

test('normal merge preserves unrelated fields, Jev disabled states and credential placeholders', async () => {
  const fixture = await makeFixture()
  try {
    const before = await readFile(fixture.patchPath, 'utf8')
    const output = await configureDevelopmentProfile({
      profileDir: fixture.profile,
      appPath: fixture.app,
      apply: true,
      processListText: '',
    })
    assert.equal(output.changed, true)
    assert.equal(output.launcher, fixture.launcher)
    assert.equal(output.hostmodules, fixture.hostmodules)
    assert.ok(output.backup)
    assert.equal((await stat(output.backup)).mode & 0o777, 0o600)

    const yaml = createRequire(join(fixture.profile, 'package.json'))('yaml')
    const entries = yaml.parse(await readFile(fixture.patchPath, 'utf8'))
    const bench = entries.find((entry) => entry.id === 'solar-bench')
    assert.deepEqual(bench.config, { keep: 'bench-setting', launcher: [fixture.launcher] })
    assert.deepEqual(entries.find((entry) => entry.id === 'unrelated'), {
      id: 'unrelated', disabled: false, credential: 'SECRET_PLACEHOLDER', config: { keep: true },
    })
    assert.deepEqual(entries.filter((entry) => entry.id.startsWith('jev')).map((entry) => entry.disabled), Array(9).fill(true))
    assert.equal((await readFile(output.backup, 'utf8')), before)
  } finally {
    await cleanup(fixture)
  }
})

test('ASAR bundle accepts the archive marker and still configures the bundled CLI launcher', async () => {
  const fixture = await makeFixture({ asar: true, patch: JSON.stringify([{ id: 'unrelated' }]) + '\n' })
  try {
    const result = await configureDevelopmentProfile({
      profileDir: fixture.profile,
      appPath: fixture.app,
      apply: true,
      processListText: '',
    })
    assert.equal(result.launcher, fixture.launcher)
    assert.equal(result.hostmodules, fixture.hostmodules)
    assert.match(result.hostmodules, /Contents\/Resources\/app\.asar\/dsh\/node_modules$/)
    assert.equal(result.changed, true)
  } finally {
    await cleanup(fixture)
  }
})

test('read-only check does not write and apply is idempotent', async () => {
  const fixture = await makeFixture({ patch: JSON.stringify([{ id: 'unrelated', credential: 'SECRET_PLACEHOLDER' }]) + '\n' })
  try {
    const before = await readFile(fixture.patchPath, 'utf8')
    const check = await runCli(fixture)
    assert.equal(check.code, 0, check.stderr)
    const checkOutput = parseOutput(check.stdout)
    assert.equal(checkOutput.changed, true)
    assert.equal(checkOutput.backup, null)
    assert.equal(await readFile(fixture.patchPath, 'utf8'), before)
    assert.equal((await readdir(fixture.profile)).some((name) => name.includes('.bak.')), false)

    const appliedOutput = await configureDevelopmentProfile({
      profileDir: fixture.profile,
      appPath: fixture.app,
      apply: true,
      processListText: '',
    })
    assert.equal(appliedOutput.changed, true)
    const afterFirstApply = await readFile(fixture.patchPath, 'utf8')
    const secondOutput = await configureDevelopmentProfile({
      profileDir: fixture.profile,
      appPath: fixture.app,
      apply: true,
      processListText: '',
    })
    assert.equal(secondOutput.changed, false)
    assert.equal(secondOutput.backup, null)
    assert.equal(await readFile(fixture.patchPath, 'utf8'), afterFirstApply)
    assert.equal((await readdir(fixture.profile)).filter((name) => name.includes('.bak.')).length, 1)

    const livePs = `424242 1 ${fixture.app}/Contents/MacOS/DeepSeek Harness\n`
    const readOnlyWithLiveApp = await configureDevelopmentProfile({ profileDir: fixture.profile, appPath: fixture.app, processListText: livePs })
    assert.equal(readOnlyWithLiveApp.changed, false)
  } finally {
    await cleanup(fixture)
  }
})

test('duplicate solar-bench and invalid YAML fail before any write', async () => {
  const duplicate = await makeFixture({ patch: JSON.stringify([
    { id: 'solar-bench', config: { launcher: ['/one'] } },
    { id: 'solar-bench', config: { launcher: ['/two'] } },
  ]) + '\n' })
  try {
    const before = await readFile(duplicate.patchPath, 'utf8')
    const result = await runCli(duplicate, ['--apply'])
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /multiple solar-bench/)
    assert.equal(await readFile(duplicate.patchPath, 'utf8'), before)
    assert.equal((await readdir(duplicate.profile)).some((name) => name.includes('.bak.')), false)
  } finally {
    await cleanup(duplicate)
  }

  const invalid = await makeFixture({ patch: '- id: [broken\n' })
  try {
    const before = await readFile(invalid.patchPath, 'utf8')
    const result = await runCli(invalid, ['--apply'])
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /could not parse/)
    assert.equal(await readFile(invalid.patchPath, 'utf8'), before)
    assert.equal((await readdir(invalid.profile)).some((name) => name.includes('.bak.')), false)
  } finally {
    await cleanup(invalid)
  }
})

test('missing launcher, missing app argument and malformed id fail without writes', async () => {
  const missingCli = await makeFixture()
  try {
    await rm(missingCli.launcher)
    const before = await readFile(missingCli.patchPath, 'utf8')
    const result = await runCli(missingCli, ['--apply'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /bundled dsh launcher does not exist/)
    assert.equal(await readFile(missingCli.patchPath, 'utf8'), before)
  } finally {
    await cleanup(missingCli)
  }

  const missingAppArg = await makeFixture()
  try {
    const before = await readFile(missingAppArg.patchPath, 'utf8')
    const result = await execFile(process.execPath, [SCRIPT, '--profile', missingAppArg.profile], { cwd: ROOT, encoding: 'utf8' }).catch((error) => error)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /--app .* is required/)
    assert.equal(await readFile(missingAppArg.patchPath, 'utf8'), before)
  } finally {
    await cleanup(missingAppArg)
  }

  const malformed = await makeFixture({ patch: JSON.stringify([{ id: 42, credential: 'SECRET_PLACEHOLDER' }]) + '\n' })
  try {
    const before = await readFile(malformed.patchPath, 'utf8')
    const result = await runCli(malformed, ['--apply'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /malformed id/)
    assert.equal(await readFile(malformed.patchPath, 'utf8'), before)
  } finally {
    await cleanup(malformed)
  }
})

test('installed package name is checked before profile writes', async () => {
  const fixture = await makeFixture()
  try {
    await writeFile(join(fixture.profile, 'node_modules', '@lisihao', 'dsh-solar-bench', 'package.json'), JSON.stringify({ name: '@other/package', version: '0.1.0-dev.0' }))
    const before = await readFile(fixture.patchPath, 'utf8')
    const result = await runCli(fixture, ['--apply'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /does not declare name @lisihao\/dsh-solar-bench/)
    assert.equal(await readFile(fixture.patchPath, 'utf8'), before)
  } finally {
    await cleanup(fixture)
  }
})

test('live-app guard detects app executables, blocks a DSH parent, and ignores argument-only mentions', () => {
  const appPath = '/tmp/fixture/DeepSeek Harness.app'
  const ps = [
    `424242 1 ${appPath}/Contents/MacOS/DeepSeek Harness`,
    '424243 1 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '424244 1 /Users/fixture/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    `424245 424242 /usr/local/bin/node ${appPath} --profile /tmp/profile`,
  ].join('\n')
  const matches = findLiveApplicationProcesses(ps, appPath, { homeDir: '/Users/fixture', ignoredPids: [] })
  assert.equal(matches.length, 3)
  assert.throws(() => assertApplicationsStopped(ps, appPath, { homeDir: '/Users/fixture', ignoredPids: [] }), /active DeepSeek Harness process detected/)

  const argumentOnly = `424246 1 /usr/local/bin/node --app ${appPath}`
  assert.deepEqual(findLiveApplicationProcesses(argumentOnly, appPath, { homeDir: '/Users/fixture', ignoredPids: [] }), [])
})
