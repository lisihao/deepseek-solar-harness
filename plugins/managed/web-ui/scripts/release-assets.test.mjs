/**
 * Tests for release-assets.mjs: the package walk mirrors verify-version.mjs
 * (packages/* + packages/skins/*, non-recursive), and packOne downloads the
 * exact published version from the npm registry into the asset directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageFiles, packOne } from './release-assets.mjs'

test('packageFiles: walks packages/ and packages/skins/ non-recursively', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-assets-'))
  try {
    for (const pkg of [
      'packages/dsh-ssh/package.json',
      'packages/dsh-skins/package.json',
      'packages/skins/miku/package.json',
      'packages/skins/skin-center/package.json',
    ]) {
      mkdirSync(join(dir, pkg, '..'), { recursive: true })
      writeFileSync(join(dir, pkg), JSON.stringify({ name: 'x', version: '0.1.15' }))
    }
    // A nested carrier must NOT be picked up (it is not a publish root).
    mkdirSync(join(dir, 'packages/dsh-skins/skins/qq98'), { recursive: true })
    writeFileSync(join(dir, 'packages/dsh-skins/skins/qq98/package.json'), JSON.stringify({ name: 'nested', version: '0.1.15' }))
    const files = packageFiles(dir)
    assert.deepEqual(files, [
      join(dir, 'packages/dsh-skins/package.json'),
      join(dir, 'packages/dsh-ssh/package.json'),
      join(dir, 'packages/skins/miku/package.json'),
      join(dir, 'packages/skins/skin-center/package.json'),
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packOne: packs the exact published version and resolves the tarball path', () => {
  const calls = []
  const fakeRun = (file, args, options) => {
    calls.push({ file, args, options })
    return JSON.stringify([{ filename: 'linxin666-dsh-ssh-0.1.15.tgz' }])
  }
  const out = packOne('@linxin666/dsh-ssh', '0.1.15', '/tmp/assets', fakeRun)
  assert.deepEqual(calls[0].args, [
    'pack', '@linxin666/dsh-ssh@0.1.15', '--pack-destination', '/tmp/assets', '--json',
  ])
  assert.equal(out, join('/tmp/assets', 'linxin666-dsh-ssh-0.1.15.tgz'))
})

test('packOne: rejects when npm pack reports no filename', () => {
  const fakeRun = () => JSON.stringify([])
  assert.throws(() => packOne('@linxin666/dsh-ssh', '0.1.15', '/tmp/assets', fakeRun), /no filename/)
})
