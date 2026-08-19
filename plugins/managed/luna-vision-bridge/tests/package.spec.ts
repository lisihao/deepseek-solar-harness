import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

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

  it('starts Codex as an isolated vision-only subscription turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-luna-launcher-'))
    const codex = join(root, 'codex')
    const image = join(root, 'image.png')
    try {
      await writeFile(codex, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
      await chmod(codex, 0o700)
      await writeFile(image, 'image')

      const launcher = fileURLToPath(new URL('../scripts/read-image-luna.sh', import.meta.url))
      const { stdout } = await execFileAsync(launcher, [
        '--codex', codex,
        '--model', 'gpt-5.6-luna',
        image,
        'describe',
      ])
      const args = stdout.trim().split('\n')

      expect(args).toContain('--ignore-user-config')
      expect(args).toContain('skills.include_instructions=false')
      expect(args).toContain('include_apps_instructions=false')
      expect(args).toContain('shell_tool')
      expect(args).toContain('unified_exec')
      expect(args).toContain('view_image')
      expect(args).toContain('plugins')
      expect(args).toContain('apps')
      expect(args).toContain('skill_search')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
