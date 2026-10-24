import { readFileSync } from 'node:fs'
process.exit(readFileSync('answer.txt', 'utf8').trim() === '43' ? 0 : 1)
