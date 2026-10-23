import { readFileSync } from 'node:fs'
process.exit(readFileSync('answer.txt', 'utf8').trim() === '5' ? 0 : 1)
