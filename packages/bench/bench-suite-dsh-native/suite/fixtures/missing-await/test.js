import assert from 'node:assert/strict'
import { userName } from './user.js'

assert.equal(await userName(7), 'user-7')
