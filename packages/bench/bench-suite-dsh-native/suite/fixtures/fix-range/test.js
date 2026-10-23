import assert from 'node:assert/strict'
import { range } from './range.js'

assert.deepEqual(range(0), [])
assert.deepEqual(range(1), [0])
assert.deepEqual(range(4), [0, 1, 2, 3])
