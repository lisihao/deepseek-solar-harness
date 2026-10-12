import { describe, expect, test } from 'vitest'
import { unpackedAsarPath } from './asar.ts'

const archive = '/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/@linxin666/dsh-liangshen/presets/'
const unpacked = '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@linxin666/dsh-liangshen/presets/'

describe('unpackedAsarPath', () => {
  test('uses the unpacked twin of a path inside the archive when it exists', () => {
    expect(unpackedAsarPath(archive, candidate => candidate === unpacked)).toBe(unpacked)
  })

  test('keeps the archive path when nothing was unpacked there', () => {
    expect(unpackedAsarPath(archive, () => false)).toBe(archive)
  })

  test('leaves a path outside any archive unchanged without probing the disk', () => {
    const plain = '/Users/me/dsh-liangshen/presets/'
    expect(unpackedAsarPath(plain, () => { throw new Error('probed') })).toBe(plain)
  })

  test('handles Windows separators', () => {
    expect(unpackedAsarPath('C:\\App\\resources\\app.asar\\node_modules\\x', () => true))
      .toBe('C:\\App\\resources\\app.asar.unpacked\\node_modules\\x')
  })

  test('probes the real file system by default', () => {
    expect(unpackedAsarPath('/tmp/not-an-archive/')).toBe('/tmp/not-an-archive/')
    expect(unpackedAsarPath('/nonexistent/app.asar/x')).toBe('/nonexistent/app.asar/x')
  })
})
