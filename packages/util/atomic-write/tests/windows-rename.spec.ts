import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicSync } from '../src/index.ts'

const renameState = vi.hoisted(() => ({
  code: 'EPERM',
  failures: 0,
  calls: 0,
}))

/** Count one rename call and throw the injected error while failures remain. */
function injectRenameFailure(): void {
  renameState.calls++
  if (renameState.failures <= 0) return
  renameState.failures--
  throw Object.assign(new Error(`${renameState.code}: injected rename failure`), { code: renameState.code })
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      injectRenameFailure()
      return actual.rename(...args)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      injectRenameFailure()
      actual.renameSync(...args)
    },
  }
})

const dirs: string[] = []

async function existingTarget(): Promise<{ dir: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-rename-'))
  dirs.push(dir)
  const target = join(dir, 'task-templates.json')
  await writeFile(target, 'old')
  return { dir, target }
}

function inject(code: string, failures: number, platform: NodeJS.Platform = 'win32'): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  renameState.code = code
  renameState.failures = failures
  renameState.calls = 0
}

afterEach(async () => {
  renameState.failures = 0
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const writers = {
  async: (target: string, content: string) => writeFileAtomic(target, content, { mode: 0o600 }),
  sync: async (target: string, content: string) => { writeFileAtomicSync(target, content, { mode: 0o600 }) },
}

describe.each(Object.entries(writers))('%s atomic write Windows rename sharing violations', (_name, write) => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s until the held target is released', async (code) => {
    const { dir, target } = await existingTarget()
    inject(code, 3)

    await write(target, 'new')

    expect(renameState.calls).toBe(4)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['task-templates.json'])
  })

  it('rethrows the last sharing violation after the bounded retries and removes the temp', async () => {
    const { dir, target } = await existingTarget()
    inject('EPERM', Number.POSITIVE_INFINITY)

    await expect(write(target, 'new')).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameState.calls).toBe(6)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['task-templates.json'])
  })

  it('rethrows a non-sharing rename failure on Windows without retrying', async () => {
    const { dir, target } = await existingTarget()
    inject('EXDEV', 1)

    await expect(write(target, 'new')).rejects.toMatchObject({ code: 'EXDEV' })

    expect(renameState.calls).toBe(1)
    expect(await readdir(dir)).toEqual(['task-templates.json'])
  })

  it('rethrows EPERM without retrying off Windows', async () => {
    const { dir, target } = await existingTarget()
    inject('EPERM', 1, 'linux')

    await expect(write(target, 'new')).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameState.calls).toBe(1)
    expect(await readdir(dir)).toEqual(['task-templates.json'])
  })
})
