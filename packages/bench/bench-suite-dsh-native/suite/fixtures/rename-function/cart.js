import { calcTotal } from './total.js'

export function cartSummary(items) {
  return `total: ${calcTotal(items)}`
}
