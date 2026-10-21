import assert from 'node:assert/strict'
import { sum } from './sum.js'

assert.equal(sum([]), 0)
assert.equal(sum([5]), 5)
assert.equal(sum([1, 2, 3]), 6)
