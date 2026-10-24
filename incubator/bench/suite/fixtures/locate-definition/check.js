import { readFileSync } from 'node:fs'
process.exit(readFileSync('answer.txt', 'utf8').trim() === 'src/core/http/headers.js' ? 0 : 1)
