import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const entry = resolve(directory, 'entry.ts')
const html = await readFile(resolve(directory, 'index.html'))
const cryptoShim = `
export function createHash() {
  let text = '';
  return {
    update(value) { text += String(value); return this; },
    digest() {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
      return Math.abs(hash).toString(16).padStart(8, '0').repeat(8).slice(0, 64);
    },
  };
}
`
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  plugins: [{
    name: 'fixture-node-crypto',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'fixture-node-crypto', namespace: 'fixture' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: cryptoShim, loader: 'js' }))
    },
  }],
})
const javascript = bundle.outputFiles[0]?.contents
if (javascript === undefined) throw new Error('model-catalog fixture bundle is empty')

const port = Number(process.argv[2] ?? '4173')
const server = createServer((request, response) => {
  if (request.url === '/model-catalog-fixture.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(javascript)
    return
  }
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
    return
  }
  response.writeHead(404)
  response.end('Not found')
})
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`model-catalog fixture listening at http://127.0.0.1:${port}\n`)
})
