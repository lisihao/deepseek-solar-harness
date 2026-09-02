import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const unsupportedWorkspaces = [
  'packages/sandbox/sandbox-windows-acl',
  'packages/shell/pwsh-local',
  'packages/shell/pwsh-sandbox',
  'packages/shell/tool-pwsh',
] as const

const dormantFiles = [
  'packages/fs/fs-local/src/win32.ts',
  'packages/fs/fs-local/tests/win32.spec.ts',
  'packages/host/directory-picker-native/src/win32-dialog*.ts',
  'packages/host/directory-picker-native/tests/built-worker.e2e.ts',
  'packages/host/directory-picker-native/tests/win32-dialog*.spec.ts',
  'packages/session/session-persistence-jsonl/src/win32.ts',
  'packages/session/session-persistence-jsonl/tests/win32.spec.ts',
  'packages/sandbox/sandbox-local/tests/acl-grants.spec.ts',
  'packages/util/atomic-write/tests/windows-contention.spec.ts',
] as const

describe('Darwin-only product scope', () => {
  it('keeps unsupported Windows packages outside the active workspace and build', () => {
    const workspace = yaml.load(read('pnpm-workspace.yaml')) as { packages?: string[] }
    expect(workspace.packages).toEqual(expect.arrayContaining(
      unsupportedWorkspaces.map(path => `!${path}`),
    ))

    const build = read('tsdown.config.ts')
    for (const path of unsupportedWorkspaces) expect(build).toContain(`'${path}/**'`)
  })

  it('keeps dormant compatibility files outside default lint, typecheck, test, and hygiene', () => {
    const oxlint = read('.oxlintrc.json')
    const vitest = read('vitest.config.ts')
    const knip = JSON.parse(read('knip.json')) as {
      workspaces?: Record<string, { project?: string[] }>
    }

    for (const path of unsupportedWorkspaces) {
      expect(oxlint).toContain(`"${path}/**"`)
    }
    for (const path of dormantFiles) expect(oxlint).toContain(`"${path}"`)
    expect(vitest).toContain('unsupportedWindowsTests')
    expect(vitest).toContain('unsupportedWindowsCoverageSources')
    expect((JSON.parse(read('packages/fs/fs-local/tsconfig.json')) as { exclude?: string[] }).exclude)
      .toContain('src/win32.ts')
    expect((JSON.parse(read('packages/session/session-persistence-jsonl/tsconfig.json')) as { exclude?: string[] }).exclude)
      .toContain('src/win32.ts')
    expect((JSON.parse(read('packages/host/directory-picker-native/tsconfig.json')) as { exclude?: string[] }).exclude)
      .toContain('src/win32-dialog*.ts')
    expect(knip.workspaces?.['packages/fs/fs-local']?.project).toContain('!src/win32.ts')
    expect(knip.workspaces?.['packages/session/session-persistence-jsonl']?.project).toContain('!src/win32.ts')
    expect(knip.workspaces?.['packages/host/directory-picker-native']?.project).toContain('!src/win32-dialog*.ts')
    expect(knip.workspaces?.['packages/sandbox/sandbox-local']?.project).toContain('!tests/acl-grants.spec.ts')
    expect(knip.workspaces?.['packages/util/atomic-write']?.project).toContain('!tests/windows-contention.spec.ts')
  })

  it('does not import or install Win32 native bindings in supported packages', () => {
    expect(read('packages/fs/fs-local/src/fsio.ts')).not.toContain("from './win32.ts'")
    expect(read('packages/session/session-persistence-jsonl/src/index.ts')).not.toContain("from './win32.ts'")

    for (const path of [
      'packages/fs/fs-local/package.json',
      'packages/session/session-persistence-jsonl/package.json',
    ]) {
      const manifest = JSON.parse(read(path)) as { dependencies?: Record<string, string> }
      expect(manifest.dependencies).not.toHaveProperty('koffi')
    }
    const desktop = JSON.parse(read('products/desktop/package.json')) as {
      dependenciesMeta?: Record<string, { built?: boolean }>
    }
    expect(desktop.dependenciesMeta).not.toHaveProperty('koffi')
  })
})
