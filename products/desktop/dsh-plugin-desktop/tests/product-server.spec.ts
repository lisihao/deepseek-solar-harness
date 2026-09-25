import { describe, expect, it } from 'vitest'
import { productServerArgs } from '../src/product-server.ts'

describe('product server launcher', () => {
  it('preserves network arguments and seals the deployment role', () => {
    expect(productServerArgs([
      '--host', '127.0.0.1',
      '--port', '3080',
      '--trusted-host', 'mac-mini.tailnet.example:3080',
    ])).toEqual([
      '--host', '127.0.0.1',
      '--port', '3080',
      '--trusted-host', 'mac-mini.tailnet.example:3080',
      '--deployment-role', 'server',
    ])
  })
})
