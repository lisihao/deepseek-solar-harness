import assert from 'node:assert/strict'
import test from 'node:test'

import { validateRevalidation, assertRevalidationOutput } from './revalidate.mjs'

const TASK = 'same fixed Q03 task prompt'
const RECORDS_HASH = 'a'.repeat(64)
const RULES_HASH = 'b'.repeat(64)

function manifest() {
  const inputHashes = {
    'inputs/records.jsonl': RECORDS_HASH,
    'inputs/rules.md': RULES_HASH,
  }
  return {
    kind: 'native-recursion-ipv4-revalidation-v1',
    prior: { charged: 472, confirmed: 462, unknown: 10 },
    limits: { total: 28, perTree: 14, cap: 522 },
    network: { NO_PROXY: 'chatgpt.com', dnsOrder: 'ipv4first', autoSelectFamily: false },
    conditions: [
      { id: 'v1S0', arm: 'S0', taskIndex: 1, prompt: { task: TASK }, inputHashes: { ...inputHashes } },
      { id: 'v1S', arm: 'S', taskIndex: 1, prompt: { task: TASK }, inputHashes: { ...inputHashes } },
    ],
  }
}

function cloneManifest() {
  return structuredClone(manifest())
}

function v2Manifest() {
  const value = cloneManifest()
  value.kind = 'native-recursion-no-reuse-revalidation-v2'
  value.prior = { charged: 481, confirmed: 470, unknown: 11 }
  value.network.connectionClose = true
  value.conditions[0].id = 'v2S0'
  value.conditions[1].id = 'v2S'
  return value
}

function assertInvalid(value) {
  assert.throws(
    () => validateRevalidation(value),
    error => error instanceof Error && /^RLM_REVALIDATE_/.test(error.message),
  )
}

test('accepts the fixed IPv4 Q03 revalidation manifest', () => {
  assert.equal(validateRevalidation(manifest()), true)
})

test('rejects a reduced charged prefix or an unknown-request refund', () => {
  for (const prior of [
    { charged: 471, confirmed: 462, unknown: 10 },
    { charged: 472, confirmed: 462, unknown: 9 },
    { charged: 472, confirmed: 461, unknown: 10 },
  ]) {
    const value = cloneManifest()
    value.prior = prior
    assertInvalid(value)
  }
})

test('rejects changes to total, per-tree, or cumulative budget limits', () => {
  for (const [field, changed] of [['total', 27], ['perTree', 13], ['cap', 521]]) {
    const value = cloneManifest()
    value.limits[field] = changed
    assertInvalid(value)
  }
})

test('requires the accepted process-local IPv4 network settings', () => {
  for (const [field, changed] of [
    ['NO_PROXY', 'example.com'],
    ['dnsOrder', 'verbatim'],
    ['autoSelectFamily', true],
  ]) {
    const value = cloneManifest()
    value.network[field] = changed
    assertInvalid(value)
  }
})

test('requires the two conditions in fixed v1S0 then v1S order with fixed arms', () => {
  const reversed = cloneManifest()
  reversed.conditions.reverse()
  assertInvalid(reversed)

  const wrongId = cloneManifest()
  wrongId.conditions[0].id = 'v1S'
  assertInvalid(wrongId)

  const wrongArm = cloneManifest()
  wrongArm.conditions[1].arm = 'S0'
  assertInvalid(wrongArm)
})

test('requires both conditions to use the same task and input hashes', () => {
  const task = cloneManifest()
  task.conditions[1].prompt.task = 'different task'
  assertInvalid(task)

  for (const path of ['inputs/records.jsonl', 'inputs/rules.md']) {
    const hashes = cloneManifest()
    hashes.conditions[1].inputHashes[path] = 'c'.repeat(64)
    assertInvalid(hashes)
  }
})

test('rejects a changed task index and any third or fifth condition', () => {
  const taskIndex = cloneManifest()
  taskIndex.conditions[1].taskIndex = 2
  assertInvalid(taskIndex)

  const third = cloneManifest()
  third.conditions.push(structuredClone(third.conditions[1]))
  assertInvalid(third)

  const fifth = cloneManifest()
  fifth.conditions = [
    structuredClone(fifth.conditions[0]),
    structuredClone(fifth.conditions[1]),
    structuredClone(fifth.conditions[0]),
    structuredClone(fifth.conditions[1]),
    structuredClone(fifth.conditions[0]),
  ]
  assertInvalid(fifth)
})

test('does not mutate the accepted manifest while validating it', () => {
  const value = manifest()
  const before = structuredClone(value)
  assert.equal(validateRevalidation(value), true)
  assert.deepEqual(value, before)
})

test('accepts the v2 no-reuse revalidation manifest', () => {
  assert.equal(validateRevalidation(v2Manifest()), true)
})

test('rejects a v2 prefix reduction or unknown-request refund', () => {
  for (const prior of [
    { charged: 480, confirmed: 470, unknown: 11 },
    { charged: 481, confirmed: 470, unknown: 10 },
  ]) {
    const value = v2Manifest()
    value.prior = prior
    assertInvalid(value)
  }
})

test('requires connectionClose for the v2 no-reuse profile', () => {
  const value = v2Manifest()
  value.network.connectionClose = false
  assertInvalid(value)
})

test('rejects v1 and v2 condition ids mixed in one manifest', () => {
  const v2WithV1Condition = v2Manifest()
  v2WithV1Condition.conditions[0].id = 'v1S0'
  assertInvalid(v2WithV1Condition)

  const v1WithV2Condition = cloneManifest()
  v1WithV2Condition.conditions[1].id = 'v2S'
  assertInvalid(v1WithV2Condition)
})

test('historical phases have fixed one-shot output namespaces', () => {
  assert.equal(assertRevalidationOutput('/fixture/original', '/fixture/original/revalidation/ipv4-v1'), '/fixture/original/revalidation/ipv4-v1')
  assert.equal(assertRevalidationOutput('/fixture/original', '/fixture/original/revalidation/no-reuse-v2', true), '/fixture/original/revalidation/no-reuse-v2')
})

test('a fresh directory cannot reuse an old charged prefix', () => {
  assert.throws(() => assertRevalidationOutput('/fixture/original', '/fixture/another-attempt'), /RLM_REVALIDATE_FRESH/)
  assert.throws(() => assertRevalidationOutput('/fixture/original', '/fixture/original/revalidation/ipv4-v1', true), /RLM_REVALIDATE_FRESH/)
})
