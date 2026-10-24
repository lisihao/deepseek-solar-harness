import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

assert.deepEqual(JSON.parse(readFileSync('config.json', 'utf8')), { name: 'svc', port: 8080, debug: false, hosts: ['a', 'b'] })
