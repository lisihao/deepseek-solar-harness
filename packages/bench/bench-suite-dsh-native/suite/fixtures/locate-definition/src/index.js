import { parseHeader } from './lib/http/headers.js'
export const run = text => parseHeader(text)
