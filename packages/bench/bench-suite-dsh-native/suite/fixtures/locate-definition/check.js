import { readFileSync } from 'node:fs'
process.exit(readFileSync('answer.txt', 'utf8').trim() === 'src/lib/http/headers.js' ? 0 : 1)
