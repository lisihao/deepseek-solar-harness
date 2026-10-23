import { calcTotal } from './total.js'
import { cartSummary } from './cart.js'

const items = [{ price: 2, qty: 3 }, { price: 5, qty: 1 }]
console.log(calcTotal(items), cartSummary(items))
