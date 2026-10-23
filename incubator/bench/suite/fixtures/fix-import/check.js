import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

assert.equal(execFileSync(process.execPath, ['main.js'], { encoding: 'utf8' }).trim(), '[ok]')
