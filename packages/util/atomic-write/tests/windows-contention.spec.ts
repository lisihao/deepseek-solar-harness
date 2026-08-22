import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '../src/index.ts'

const fsState = vi.hoisted(() => ({
  epermMode: undefined as 'existing' | 'absent' | undefined,
  removeExistingLockAfterStat: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: never[]) => {
      if (fsState.epermMode !== undefined && String(path).endsWith('.lock')) {
        const mode = fsState.epermMode
        fsState.epermMode = undefined
        if (mode === 'existing') {
          await actual.writeFile(path as Parameters<typeof actual.writeFile>[0], 'other-writer\n', {
            mode: 0o600,
            flag: 'wx',
          })
          fsState.removeExistingLockAfterStat = true
        }
        throw Object.assign(new Error('EPERM: injected Windows lock-create result'), { code: 'EPERM' })
      }
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
    lstat: (async (path: unknown, ...rest: never[]) => {
      const result = await (actual.lstat as (path: unknown, ...args: never[]) => ReturnType<typeof actual.lstat>)(path, ...rest)
      if (fsState.removeExistingLockAfterStat && String(path).endsWith('.lock')) {
        fsState.removeExistingLockAfterStat = false
        await actual.rm(path as Parameters<typeof actual.rm>[0], { force: true })
      }
      return result
    }) as typeof actual.lstat,
  }
})

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  fsState.epermMode = undefined
  fsState.removeExistingLockAfterStat = false
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('withFileLock Windows contention classification', () => {
  it('retries EPERM when the exclusively-created lock exists', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = join(await scratch(), 'document')
    fsState.epermMode = 'existing'

    await expect(withFileLock(target, async () => 'completed')).resolves.toBe('completed')
    await expect(access(`${target}.lock`)).rejects.toThrow()
  })

  it('rethrows EPERM when no lock exists at the reported path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = join(await scratch(), 'document')
    fsState.epermMode = 'absent'

    await expect(withFileLock(target, async () => 'unreachable')).rejects.toMatchObject({ code: 'EPERM' })
    await expect(access(`${target}.lock`)).rejects.toThrow()
  })
})
