import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = resolve(fixtureRoot, '../../..')
const output = '/private/tmp/dsh-workflow-studio-fixture'

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Workflow Studio browser fixture</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111318; }
      body { margin: 0; min-width: 320px; background: #111318; }
      #root { min-height: 100vh; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./workflow-studio-fixture.js"></script>
  </body>
</html>
`

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await build({
  entryPoints: [join(fixtureRoot, 'src', 'main.ts')],
  absWorkingDir: repositoryRoot,
  outfile: join(output, 'workflow-studio-fixture.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  loader: { '.css': 'text' },
})
await writeFile(join(output, 'index.html'), html)
process.stdout.write(`${JSON.stringify({ output, entry: join(output, 'index.html') })}\n`)
