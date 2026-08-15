import assert from 'node:assert/strict'
import test from 'node:test'
import { dshCommand, verifyDumpConfig, withGovernedProfile } from '../lib/preflight.js'

const valid = `
- id: code-harness-invariants
  name: '@deepseek-ai/dsh-invariants'
  config:
    enabled: true
- id: code-harness-governance
  name: '@lisihao/dsh-code-harness-governance'
  config:
    strict: true
- id: code-harness-governance-invariant
  name: '@lisihao/dsh-code-harness-governance/invariant'
`

test('preflight accepts the policy, invariant, and strict marker', () => {
  assert.deepEqual(verifyDumpConfig(valid), {
    ok: true,
    missing: [],
    message: 'governance policy and invariant are present in the final composed configuration',
  })
})

test('preflight fails closed when an overlay removes the invariant', () => {
  const verdict = verifyDumpConfig(valid.replace("name: '@lisihao/dsh-code-harness-governance/invariant'", "name: 'noop'"))
  assert.equal(verdict.ok, false)
  assert.match(verdict.message, /missing required governance config/)
})

test('preflight fails closed when a required row is disabled', () => {
  const disabled = valid.replace(
    "  name: '@lisihao/dsh-code-harness-governance/invariant'",
    "  name: '@lisihao/dsh-code-harness-governance/invariant'\n  disabled: true",
  )
  const verdict = verifyDumpConfig(disabled)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.missing.includes('code-harness-governance-invariant enabled'))
})

test('launcher adds governed-code unless a profile is explicit', () => {
  assert.deepEqual(withGovernedProfile(['web']), ['--profile', 'governed-code', 'web'])
  assert.deepEqual(withGovernedProfile(['--profile', 'custom']), ['--profile', 'custom'])
})

test('source checkouts can supply an argv-safe DSH command', () => {
  assert.deepEqual(dshCommand({ DSH_COMMAND_JSON: '["node","--import","tsx/esm","apps/cli/src/bin.ts"]' }), [
    'node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
  ])
  assert.throws(() => dshCommand({ DSH_COMMAND_JSON: '"dsh"' }), /must be a non-empty JSON array/)
})
