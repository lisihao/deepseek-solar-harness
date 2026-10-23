import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { digest, loadRuntime, PRIME_COMMIT, type RuntimeManifest } from '../src/runtime.js'

const exec = promisify(execFile)
const temporaryRoots: string[] = []
const targetIt = it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Prime runtime capsule', () => {
  targetIt('extracts cold, validates every manifest critical file on a hot load, and returns stable paths', async () => {
    const fixture = await createFixture()
    const first = await loadRuntime(fixture.packageRoot, fixture.dataRoot)
    expect(first).toMatchObject({
      binary: join(fixture.dataRoot, 'runtimes', fixture.manifest.archiveSha256, 'prime/prime-agent'),
      python: join(fixture.dataRoot, 'runtimes', fixture.manifest.archiveSha256, 'python/bin/python3'),
      packageDir: join(fixture.dataRoot, 'runtimes', fixture.manifest.archiveSha256, 'prime'),
      fingerprint: fixture.manifest.archiveSha256,
    })
    await expect(readFile(join(fixture.dataRoot, 'runtimes', fixture.manifest.archiveSha256, 'complete.json'), 'utf8')).resolves.toContain('criticalFiles')
    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).resolves.toEqual(first)

    const machineFile = join(first.packageDir, 'prime-agent-runtime/src/rlm/MACHINE.md')
    await writeFile(machineFile, 'changed after extraction')
    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).rejects.toThrow('RLM_RUNTIME_CRITICAL')
    await expect(readFile(machineFile, 'utf8')).resolves.toBe('changed after extraction')
  })

  targetIt('rejects an archive digest mismatch before creating a runtime target', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.archive, Buffer.concat([await readFile(fixture.archive), Buffer.from('tampered')]))

    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).rejects.toThrow('RLM_RUNTIME_DIGEST')
    await expect(readdir(join(fixture.dataRoot, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  targetIt('rejects unsafe archive links before extraction', async () => {
    const fixture = await createFixture({ unsafeLink: true })

    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).rejects.toThrow('RLM_RUNTIME_ARCHIVE')
    await expect(readdir(join(fixture.dataRoot, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unknown format, wrong pin, platform, and SHA fields', async () => {
    const cases: Array<[string, (manifest: RuntimeManifest) => RuntimeManifest]> = [
      ['format', (manifest) => ({ ...manifest, formatVersion: 2 as 1 })],
      ['pin', (manifest) => ({ ...manifest, primeCommit: 'bad' })],
      ['platform', (manifest) => ({ ...manifest, platform: 'linux' as 'darwin' })],
      ['archive sha', (manifest) => ({ ...manifest, archiveSha256: 'bad' })],
      ['binary sha', (manifest) => ({ ...manifest, binarySha256: 'bad' })],
      ['critical path', (manifest) => ({ ...manifest, criticalFiles: { ...manifest.criticalFiles, '../escape': 'a'.repeat(64) } })],
    ]

    for (const [name, mutate] of cases) {
      const fixture = await createFixture()
      await writeFile(fixture.manifestPath, `${JSON.stringify(mutate(fixture.manifest))}\n`)
      await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot), name).rejects.toThrow('RLM_RUNTIME_UNSUPPORTED')
    }
  })

  targetIt('cleans the unique temporary directory and leaves no partial target after a critical-file failure', async () => {
    const fixture = await createFixture({ missingCriticalFile: true })

    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).rejects.toThrow('RLM_RUNTIME_CRITICAL')
    await expect(readdir(join(fixture.dataRoot, 'runtimes'))).resolves.toEqual([])
  })

  targetIt('preserves an existing target when its atomic completion marker is invalid', async () => {
    const fixture = await createFixture()
    const paths = await loadRuntime(fixture.packageRoot, fixture.dataRoot)
    const target = join(fixture.dataRoot, 'runtimes', fixture.manifest.archiveSha256)
    const marker = join(target, 'complete.json')
    await writeFile(marker, '{"formatVersion":999}')
    const sentinel = join(target, 'sentinel')
    await writeFile(sentinel, 'keep this target')

    await expect(loadRuntime(fixture.packageRoot, fixture.dataRoot)).rejects.toThrow('RLM_RUNTIME_MARKER')
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep this target')
    await expect(readFile(paths.binary)).resolves.toEqual(Buffer.from('prime-binary'))
  })
})

interface Fixture {
  readonly packageRoot: string
  readonly dataRoot: string
  readonly archive: string
  readonly manifestPath: string
  readonly manifest: RuntimeManifest
}

async function createFixture(options: { readonly unsafeLink?: boolean; readonly missingCriticalFile?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-'))
  temporaryRoots.push(root)
  const packageRoot = join(root, 'package')
  const dataRoot = join(root, 'data')
  const payload = join(root, 'payload')
  const assets = join(packageRoot, 'assets')
  await Promise.all([
    mkdir(join(payload, 'prime/prime-agent-runtime/src/rlm'), { recursive: true }),
    mkdir(join(payload, 'prime/skills'), { recursive: true }),
    mkdir(join(payload, 'python/bin'), { recursive: true }),
    mkdir(join(payload, 'locks'), { recursive: true }),
    mkdir(join(payload, 'licenses'), { recursive: true }),
    mkdir(assets, { recursive: true }),
  ])
  await writeFile(join(payload, 'prime/prime-agent'), 'prime-binary')
  await chmod(join(payload, 'prime/prime-agent'), 0o755)
  await writeFile(join(payload, 'prime/package.json'), '{"name":"prime-agent","version":"fixture"}\n')
  await writeFile(join(payload, 'prime/prime-agent-runtime/pyproject.toml'), '[project]\nname="prime-agent-runtime"\n')
  await writeFile(join(payload, 'prime/prime-agent-runtime/src/rlm/MACHINE.md'), 'machine data')
  await writeFile(join(payload, 'prime/skills/example.py'), 'print("fixture")\n')
  await writeFile(join(payload, 'locks/Cargo.lock'), '# fixture lock\n')
  await writeFile(join(payload, 'licenses/MIT'), 'MIT\n')
  await writeFile(join(payload, 'python/bin/python3.12'), '#!/bin/sh\nexit 0\n')
  await chmod(join(payload, 'python/bin/python3.12'), 0o755)
  await symlink('python3.12', join(payload, 'python/bin/python3'))
  if (options.unsafeLink === true) await symlink('../../../../outside', join(payload, 'prime/escape'))

  const archive = join(assets, 'runtime.tar.gz')
  await exec('/usr/bin/tar', ['-czf', archive, '-C', payload, '.'])
  const criticalFiles: Record<string, string> = {}
  for (const path of [
    'prime/prime-agent',
    'python/bin/python3',
    'prime/package.json',
    'prime/prime-agent-runtime/pyproject.toml',
    'prime/prime-agent-runtime/src/rlm/MACHINE.md',
    'prime/skills/example.py',
    'locks/Cargo.lock',
  ]) criticalFiles[path] = await digest(join(payload, path))
  if (options.missingCriticalFile === true) criticalFiles['prime/required.txt'] = 'a'.repeat(64)
  const manifest: RuntimeManifest = {
    formatVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    primeCommit: PRIME_COMMIT,
    archiveSha256: await digest(archive),
    binarySha256: criticalFiles['prime/prime-agent']!,
    pythonVersion: '3.12.13',
    criticalFiles,
    sourceEvidence: { sourceCommit: PRIME_COMMIT },
    packageLayout: { binary: 'prime/prime-agent', python: 'python/bin/python3' },
  }
  const manifestPath = join(assets, 'runtime-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  return { packageRoot, dataRoot, archive, manifestPath, manifest }
}
