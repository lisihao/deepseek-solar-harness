import { describe } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loadDeclarativeSuite } from '@deepseek-ai/dsh-bench'
import { describeSuiteConformance } from '@deepseek-ai/dsh-bench-testkit'
import { SUITE_DIR } from '@deepseek-ai/dsh-bench-suite-dsh-native'

const bashCall = { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } } as SessionEvent

const suite = await loadDeclarativeSuite(SUITE_DIR)

describe('dsh-native suite', () => {
  describeSuiteConformance({
    suite,
    runs: {
      'fix-sum-bug': {
        pass: { files: { 'sum.js': 'export function sum(values) {\n  let total = 0\n  for (const value of values) total += value\n  return total\n}\n' } },
        fail: {},
      },
      'count-lines': { pass: { files: { 'answer.txt': '7\n' } }, fail: { files: { 'answer.txt': '6\n' } } },
      'shell-listing': { pass: { events: [bashCall] }, fail: {} },
      'rename-function': {
        pass: {
          files: {
            'total.js': 'export function computeTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0)\n}\n',
            'cart.js': "import { computeTotal } from './total.js'\n\nexport function cartSummary(items) {\n  return `total: ${computeTotal(items)}`\n}\n",
            'main.js': "import { computeTotal } from './total.js'\n\nconsole.log(computeTotal([]))\n",
          },
        },
        fail: { files: { 'total.js': 'export function computeTotal(items) {\n  return 0\n}\nexport const calcTotal = computeTotal\n' } },
      },
      'fix-range': {
        pass: { files: { 'range.js': 'export function range(n) {\n  return Array.from({ length: n }, (_, i) => i)\n}\n' } },
        fail: {},
      },
      'json-port': {
        pass: { files: { 'config.json': '{ "name": "svc", "port": 8080, "debug": false, "hosts": ["a", "b"] }\n' } },
        fail: { files: { 'config.json': '{ "port": 8080 }\n' } },
      },
      'count-todos': { pass: { files: { 'answer.txt': '5\n' } }, fail: { files: { 'answer.txt': '6\n' } } },
      'is-palindrome': {
        pass: {
          files: {
            'palindrome.js': "export function isPalindrome(text) {\n  const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '')\n  return clean === [...clean].reverse().join('')\n}\n",
          },
        },
        fail: { files: { 'palindrome.js': 'export function isPalindrome(text) {\n  return text === [...text].reverse().join(\'\')\n}\n' } },
      },
      'missing-await': {
        pass: {
          files: {
            'user.js': 'export async function fetchUser(id) {\n  return { id, name: `user-${id}` }\n}\n\nexport async function userName(id) {\n  const user = await fetchUser(id)\n  return user.name\n}\n',
          },
        },
        fail: {},
      },
      'csv-sum': { pass: { files: { 'answer.txt': '43' } }, fail: { files: { 'answer.txt': '22' } } },
      'validate-input': {
        pass: {
          files: {
            'square.js': "export function square(value) {\n  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('expected a finite number')\n  return value * value\n}\n",
          },
        },
        fail: { files: { 'square.js': "export function square(value) {\n  if (typeof value !== 'number') throw new TypeError('expected a number')\n  return value * value\n}\n" } },
      },
      'locate-definition': {
        pass: { files: { 'answer.txt': 'src/lib/http/headers.js\n' } },
        fail: { files: { 'answer.txt': 'src/legacy/headers.old.js\n' } },
      },
      'fix-import': { pass: { files: { 'main.js': "import { format } from './lib/format.js'\n\nconsole.log(format('ok'))\n" } }, fail: {} },
      'sort-by-age': {
        pass: { files: { 'sort.js': 'export function sortByAge(people) {\n  return [...people].sort((a, b) => a.age - b.age)\n}\n' } },
        fail: { files: { 'sort.js': 'export function sortByAge(people) {\n  return people.sort((a, b) => a.age - b.age)\n}\n' } },
      },
    },
  })
})
