import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('package manifest', () => {
  it('declares the bundled Luna launcher as a bin so package archives retain its executable bit', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin?: Record<string, string>
    }
    const launcher = new URL('../scripts/read-image-luna.sh', import.meta.url)

    expect(manifest.bin).toEqual({
      'dsh-read-image-luna': 'scripts/read-image-luna.sh',
    })
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
  })
})
