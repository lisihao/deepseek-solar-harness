import assert from 'node:assert/strict'
import { sortByAge } from './sort.js'

const people = [{ name: 'c', age: 30 }, { name: 'a', age: 9 }, { name: 'b', age: 100 }, { name: 'd', age: 21 }]
assert.deepEqual(sortByAge(people).map(p => p.name), ['a', 'd', 'c', 'b'])
assert.equal(people[0].name, 'c')
