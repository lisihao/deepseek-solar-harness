import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const extension = await readFile(new URL('./index.js', import.meta.url), 'utf8')
const patch = await readFile(new URL('./cordis.patch.yml', import.meta.url), 'utf8')

assert.equal(packageJson.name, 'aegis')
assert.equal(packageJson.version, '2.8.5-solar.1')
assert.deepEqual(packageJson.files, ['extensions/dsh', 'skills', 'LICENSE', 'README.md', 'README.zh-CN.md'])
assert.match(patch, /aegis\/extensions\/dsh\/index\.js/)
assert.match(extension, /export const inject = \["skills"\]/)
assert.doesNotMatch(extension, /createUserMessage|installBootstrap|agent\/session-start/)

console.log('aegis DSH method pack: skills-only advisory integration verified')
