import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_METHODS } from '../src/wire.ts'

const WIRE_SOURCE = readFileSync(new URL('../src/wire.ts', import.meta.url), 'utf8')
const WIRE_BODY = WIRE_SOURCE.slice(WIRE_SOURCE.indexOf('} as const satisfies'))

describe('CODEX_APP_SERVER_METHODS', () => {
  it('lists exactly the app-server methods the wire sends or dispatches on', () => {
    const used = new Set<string>()
    for (const match of WIRE_BODY.matchAll(/(?:request|notify)\('([^']+)'|case '([^'/]+\/[^']+)':|method (?:===|!==) '([^']+)'/gu)) {
      used.add(match[1] ?? match[2] ?? match[3] ?? '')
    }
    expect([...used].sort()).toEqual(Object.values(CODEX_APP_SERVER_METHODS).flat().sort())
  })
})
