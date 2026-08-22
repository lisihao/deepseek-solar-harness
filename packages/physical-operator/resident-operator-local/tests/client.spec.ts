import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { waitForDaemonSocketRelease } from '../src/client.ts'

describe('waitForDaemonSocketRelease', () => {
  it('returns immediately when the daemon path is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    try {
      await expect(waitForDaemonSocketRelease(join(root, 'control.sock'), 100)).resolves.toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('observes release within the bounded shutdown interval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    const control = join(root, 'control.sock')
    writeFileSync(control, '')
    const timer = setTimeout(() => { rmSync(control) }, 5)
    try {
      await expect(waitForDaemonSocketRelease(control, 100)).resolves.toBe(true)
    } finally {
      clearTimeout(timer)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a daemon path that remains past the deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    const control = join(root, 'control.sock')
    writeFileSync(control, '')
    try {
      await expect(waitForDaemonSocketRelease(control, 1)).resolves.toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
