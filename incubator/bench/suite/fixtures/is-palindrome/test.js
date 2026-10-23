import assert from 'node:assert/strict'
import { isPalindrome } from './palindrome.js'

assert.equal(isPalindrome(''), true)
assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true)
assert.equal(isPalindrome('race a car'), false)
assert.equal(isPalindrome('No lemon, no melon'), true)
