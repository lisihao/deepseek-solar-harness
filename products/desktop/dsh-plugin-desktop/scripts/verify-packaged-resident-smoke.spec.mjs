import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./verify-packaged-resident-smoke.mjs', import.meta.url))

function runSmoke(...argumentsAfterEntry) {
  return spawnSync(process.execPath, [scriptPath, ...argumentsAfterEntry], {
    encoding: 'utf8',
  })
}

function assertRejected(argumentsAfterEntry, expectedMessage) {
  const result = runSmoke(...argumentsAfterEntry)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage)
}

test('rejects unknown options instead of silently changing the smoke', () => {
  assertRejected(['--unexpected'], /unknown option: --unexpected/u)
})

test('requires a provider id after --require-provider', () => {
  assertRejected(['--require-provider'], /--require-provider requires an operator id/u)
  assertRejected(['--require-provider', '--execute'], /--require-provider requires an operator id/u)
})

test('rejects unsupported and duplicate required providers', () => {
  assertRejected(['--require-provider', 'deepseek'], /unsupported required provider: deepseek/u)
  assertRejected(['--require-provider', 'codex', '--require-provider', 'codex'], /duplicate required provider: codex/u)
})

test('rejects duplicate execute flags and multiple application paths', () => {
  assertRejected(['--execute', '--execute'], /duplicate --execute/u)
  assertRejected(['/tmp/one.app', '/tmp/two.app'], /only one application path is allowed/u)
})

test('accepts a supported provider selector before checking the package', () => {
  const result = runSmoke('/tmp/does-not-exist.app', '--require-provider', 'claude-code')
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unsupported required provider/u)
  assert.match(`${result.stdout}\n${result.stderr}`, /packaged application is missing/u)
})
