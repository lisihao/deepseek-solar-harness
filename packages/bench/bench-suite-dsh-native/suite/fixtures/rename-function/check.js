import { readdirSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

for (const file of readdirSync('.').filter(name => name.endsWith('.js') && name !== 'check.js')) {
  assert.ok(!readFileSync(file, 'utf8').includes('calcTotal'), `${file} still mentions calcTotal`)
}
const { computeTotal } = await import('./total.js')
const { cartSummary } = await import('./cart.js')
assert.equal(computeTotal([{ price: 2, qty: 3 }]), 6)
assert.equal(cartSummary([{ price: 1, qty: 4 }]), 'total: 4')
