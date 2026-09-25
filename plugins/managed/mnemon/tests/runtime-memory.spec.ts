import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_ENTRY_DELIMITER,
  RuntimeMemoryCapacityError,
  RuntimeMemoryController,
} from '../src/runtime-memory.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(now = new Date('2026-08-13T08:00:00.000Z')): { directory: string; controller: RuntimeMemoryController } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-'))
  directories.push(directory)
  return {
    directory,
    controller: new RuntimeMemoryController({ effectiveDataDir: () => directory }, () => now),
  }
}

describe('RuntimeMemoryController', () => {
  it('creates the JSON source of truth and deterministic Markdown projections', async () => {
    const { directory, controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: '用户偏好简洁回答', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: '项目使用 TypeScript', importance: 'normal' })

    const root = join(directory, 'runtime')
    const source = JSON.parse(readFileSync(join(root, 'memories.json'), 'utf8')) as { version: number; entries: unknown[] }
    expect(source).toEqual({
      version: 1,
      entries: [
        {
          content: '用户偏好简洁回答',
          created_at: '2026-08-13T08:00:00.000Z',
          updated_at: '2026-08-13T08:00:00.000Z',
          target: 'user',
          importance: 'critical',
        },
        {
          content: '项目使用 TypeScript',
          created_at: '2026-08-13T08:00:00.000Z',
          updated_at: '2026-08-13T08:00:00.000Z',
          target: 'memory',
          importance: 'normal',
        },
      ],
    })
    expect(readFileSync(join(root, 'USER.md'), 'utf8')).toBe('用户偏好简洁回答\n')
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toBe('项目使用 TypeScript\n')
    expect(existsSync(join(root, '.memories.lock'))).toBe(false)
  })

  it('projects one-line entries separated by a standalone section sign', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: '第一条\n  测试' })
    await controller.mutate({ action: 'add', target: 'memory', content: '第二条\t测试' })

    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['第一条 测试', '第二条 测试'])
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('第一条 测试\n§\n第二条 测试\n')
    expect(RUNTIME_ENTRY_DELIMITER).toBe('\n§\n')
    await expect(controller.mutate({ action: 'add', target: 'memory', content: '不能包含 § 分隔符' })).rejects.toThrow('reserved § entry delimiter')
  })

  it('supports unique-substring replace and remove while preserving creation time', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Use TypeScript for plugin code' })
    const replaced = await controller.mutate({ action: 'replace', target: 'memory', oldText: 'TypeScript', content: 'Use Rust for plugin code', importance: 'low' })
    expect(replaced).toMatchObject({ message: 'Entry replaced.', replaced: { from: 'Use TypeScript for plugin code', to: 'Use Rust for plugin code' } })
    expect(controller.snapshot().entries).toEqual([
      expect.objectContaining({ content: 'Use Rust for plugin code', importance: 'low', created_at: '2026-08-13T08:00:00.000Z' }),
    ])

    await expect(controller.mutate({ action: 'remove', target: 'memory', oldText: 'Rust' })).resolves.toMatchObject({ removed: 'Use Rust for plugin code', entryCount: 0 })
    expect(controller.snapshot().entries).toEqual([])
  })

  it('rejects ambiguous substring mutations without changing the source', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'SQLite is local-first' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'SQLite uses one file' })
    await expect(controller.mutate({ action: 'remove', target: 'memory', oldText: 'SQLite' })).rejects.toThrow('Multiple memory entries')
    expect(controller.snapshot().entries).toHaveLength(2)
  })

  it('serializes concurrent callers, including independent controller instances', async () => {
    const { directory, controller } = fixture()
    const other = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? controller : other).mutate({
      action: 'add',
      target: index % 3 === 0 ? 'user' : 'memory',
      content: `concurrent-entry-${index}`,
    })))
    const snapshot = controller.snapshot()
    expect(snapshot.entries).toHaveLength(20)
    expect(new Set(snapshot.entries.map(entry => entry.content)).size).toBe(20)
    const memoryProjection = snapshot.entries.filter(entry => entry.target === 'memory').map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe(`${memoryProjection}\n`)
  })

  it('uses UTF-8 bytes for capacity and leaves every file unchanged on overflow', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'x'.repeat(4_090) })
    const beforeJson = readFileSync(controller.sourcePath, 'utf8')
    const beforeMarkdown = readFileSync(controller.userPath, 'utf8')
    await expect(controller.mutate({ action: 'add', target: 'user', content: '超出' })).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    expect(readFileSync(controller.sourcePath, 'utf8')).toBe(beforeJson)
    expect(readFileSync(controller.userPath, 'utf8')).toBe(beforeMarkdown)
  })

  it('repairs derived files from memories.json when a controller starts', async () => {
    const { directory, controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'source-owned value' })
    writeFileSync(controller.memoryPath, 'manual edit\n')
    new RuntimeMemoryController({ effectiveDataDir: () => directory })
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('source-owned value\n')
  })

  it('renders a bounded QoderWork-style runtime context from the committed source', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers concise Chinese replies', importance: 'critical' })
    const context = controller.contextText()
    expect(context).toContain('MNEMON RUNTIME MEMORY PROTOCOL')
    expect(context).toContain('Manage hot memory exclusively with mnemon_runtime_memory')
    expect(context).toContain('Use action="add" only for a new independent fact')
    expect(context).toContain('Use action="replace" with a short unique old_text')
    expect(context).toContain('Use action="remove" with a short unique old_text')
    expect(context).toContain('The user\'s explicit request in the current turn wins over both files')
    expect(context).toContain('call mnemon_recall instead of inferring or filling the gap')
    expect(context).toContain('Contents of USER.md (user profile;')
    expect(context).toContain('<runtime-memory-file name="USER.md">\nUser prefers concise Chinese replies\n</runtime-memory-file>')
    expect(context).toContain('Contents of MEMORY.md (working reference; 0/10240 UTF-8 bytes)')
    expect(context).toContain('<runtime-memory-file name="MEMORY.md">\n(empty)\n</runtime-memory-file>')
    expect(context.match(/always relevant/gi)).toHaveLength(2)
    expect(context).not.toContain(controller.sourcePath)
  })

  it('assembles every prompt from the latest generated USER.md and MEMORY.md projections', async () => {
    const { controller } = fixture()
    const empty = controller.contextText()
    expect(empty).not.toContain('User prefers compact release notes')

    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers compact release notes', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Release checks run with pnpm verify' })
    const populated = controller.contextText()

    expect(populated).toContain('User prefers compact release notes')
    expect(populated).toContain('Release checks run with pnpm verify')
    expect(readFileSync(controller.userPath, 'utf8')).toBe('User prefers compact release notes\n')
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('Release checks run with pnpm verify\n')
  })

  it('applies a compacted target only to the exact reviewed revision', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Project uses pnpm.' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'pnpm manages workspace dependencies.' })
    const reviewed = controller.snapshot()

    await controller.compactTarget(reviewed.revision, 'memory', [{ content: 'Project uses pnpm for workspace dependency management.', importance: 'normal' }])
    expect(controller.snapshot().entries).toEqual([
      expect.objectContaining({ target: 'memory', content: 'Project uses pnpm for workspace dependency management.', importance: 'normal' }),
    ])
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('Project uses pnpm for workspace dependency management.\n')
  })

  it('never overwrites a concurrent mutation with an obsolete compaction plan', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers concise replies.' })
    const reviewed = controller.snapshot()
    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers Chinese.' })

    await expect(controller.compactTarget(reviewed.revision, 'user', [{ content: 'User prefers concise Chinese replies.', importance: 'critical' }])).rejects.toThrow('changed while archival')
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['User prefers concise replies.', 'User prefers Chinese.'])
  })

  it('packs semantic compaction candidates into an exact host-owned byte budget', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'Original verbose preference.' })
    const reviewed = controller.snapshot()

    await controller.compactTarget(reviewed.revision, 'user', [
      { content: 'normal candidate that cannot join the critical one', importance: 'normal' },
      { content: 'critical rule', importance: 'critical' },
      { content: 'low detail', importance: 'low' },
    ], 28)

    expect(controller.snapshot().entries.map(entry => ({ content: entry.content, importance: entry.importance }))).toEqual([
      { content: 'critical rule', importance: 'critical' },
      { content: 'low detail', importance: 'low' },
    ])
  })
})
