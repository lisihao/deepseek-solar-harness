import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ADAPTER_CLIENT_INJECT,
  ADAPTER_ID,
  ADAPTER_SCRIPT_PATH,
  adapterBootEntry,
  appendAdapterEntry,
  shortHash,
} from '../adapter-host.js'

const pluginRoot = new URL('../', import.meta.url)
const read = name => readFileSync(new URL(name, pluginRoot), 'utf8')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const manifestMarker = '<script>window.__DSH_BOOT__ = '

function readBootGraph(html) {
  const start = html.indexOf(manifestMarker)
  assert.notEqual(start, -1)
  const jsonStart = start + manifestMarker.length
  const end = html.indexOf('</script>', jsonStart)
  assert.notEqual(end, -1)
  return JSON.parse(html.slice(jsonStart, end))
}

test('appends one idempotent adapter row to the DSH boot manifest', () => {
  const html = '<head><script>window.__DSH_BOOT__ = '
    + JSON.stringify({ rev: 'old', entries: [] })
    + '</script></head>'
  const output = appendAdapterEntry(html, 'adapter-test')
  const graph = readBootGraph(output)
  const [entry] = graph.entries

  assert.equal(graph.entries.length, 1)
  assert.deepEqual(entry, {
    id: ADAPTER_ID,
    url: ADAPTER_SCRIPT_PATH + '?rev=adapter-test',
    rev: 'adapter-test',
    inject: ADAPTER_CLIENT_INJECT,
  })
  assert.equal(graph.rev, shortHash(JSON.stringify(graph.entries)))
  assert.equal(appendAdapterEntry(output, 'other-rev'), output)
})

test('leaves non-DSH HTML alone and rejects malformed DSH manifests', () => {
  assert.equal(appendAdapterEntry('<html><body>plain</body></html>'), '<html><body>plain</body></html>')
  assert.throws(
    () => appendAdapterEntry(manifestMarker + '{'),
    /unterminated/,
  )
  assert.throws(
    () => appendAdapterEntry(manifestMarker + JSON.stringify({ rev: 'bad' }) + '</script>'),
    /entries array/,
  )
})

test('registers the switch in the native header slot without fixed-position CSS', () => {
  const source = read('client-adapter.js')
  assert.match(source, /conversation\.session\.header\.actions/)
  assert.match(source, /order: 82/)
  assert.match(source, /dsh-synapse-overlay/)
  assert.match(source, /button\.click\(\)/)
  assert.match(source, /var\(--dsw-alias-/)
  assert.doesNotMatch(source, /position\s*:\s*fixed/)
  assert.doesNotMatch(source, /(?:^|[;\s])(top|left|transform)\s*:/)
})

test('wires the companion entry and preserves upstream runtime locks', () => {
  const pkg = JSON.parse(read('package.json'))
  const patch = read('cordis.patch.yml')
  const lock = JSON.parse(read('SOURCE-LOCK.json'))

  assert.equal(pkg.exports['./adapter-host'], './adapter-host.js')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-slots',
  ])
  assert.match(patch, /id: synapse-view-adapter-host/)
  assert.match(patch, /name: dsh-synapse\/adapter-host/)
  for (const [file, expected] of Object.entries(lock.runtime_files)) {
    assert.equal(sha256(read(file)), expected, file + ' no longer matches SOURCE-LOCK.json')
  }
})
