import { readFileSync } from 'node:fs'

const answer = readFileSync('answer.txt', 'utf8').trim()
process.exit(answer === '7' ? 0 : 1)
