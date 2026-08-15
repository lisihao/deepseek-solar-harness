import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = '@lisihao/dsh-code-harness-governance'
const ALLOWED_REQUIRES = new Set([
  'react',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'src/client.cjs')
const cssPath = resolve(root, 'src/client.css')
const targetPath = resolve(root, 'lib/client.js')
const check = process.argv.includes('--check')

const source = await readFile(sourcePath, 'utf8')
const css = await readFile(cssPath, 'utf8')
const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map(match => match[1])
const unsupported = requires.filter(id => !ALLOWED_REQUIRES.has(id))
if (unsupported.length > 0) throw new Error(`unsupported client module(s): ${unsupported.join(', ')}`)
if (/(?:#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/iu.test(css)) {
  throw new Error('client CSS must use DSH theme tokens instead of literal colors')
}

const style = [
  `const __governanceCss = ${JSON.stringify(css)};`,
  `const __governanceStyleId = ${JSON.stringify(`${PACKAGE_ID}/client.css`)};`,
  "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(__governanceStyleId) + ']') === null) {",
  "  const tag = document.createElement('style');",
  `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
  '  tag.dataset.pluginCss = __governanceStyleId;',
  '  tag.textContent = __governanceCss;',
  '  document.head.appendChild(tag);',
  '}',
].join('\n')
const artifact = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  style,
  source.trimEnd(),
  'return module.exports; } });',
  '',
].join('\n')

if (check) {
  let current = null
  try { current = await readFile(targetPath, 'utf8') } catch {}
  if (current !== artifact) {
    console.error('ERROR: lib/client.js is missing or stale; run npm run build:client')
    process.exit(1)
  }
  console.log('DSH governance client bundle is current.')
} else {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, artifact)
  console.log(`Wrote ${targetPath}`)
}
