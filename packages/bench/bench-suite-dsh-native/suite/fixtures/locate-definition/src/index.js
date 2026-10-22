import { parseHeader } from './core/http/headers.js'
export const run = text => parseHeader(text)
