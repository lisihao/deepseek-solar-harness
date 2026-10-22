import assert from 'node:assert/strict'
import { square } from './square.js'

assert.equal(square(3), 9)
assert.equal(square(-2), 4)
assert.throws(() => square('3'), TypeError)
assert.throws(() => square(Number.NaN), TypeError)
assert.throws(() => square(Infinity), TypeError)
