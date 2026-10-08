/** Task-owned source snapshots and fingerprint-fenced delivery to an unchanged source directory. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

class SnapshotDeliveryIndeterminateError extends Error {
  readonly code = 'COMMAND_INDETERMINATE'
}

/** Caller-selected filesystem and subprocess bounds for private snapshots. */
export interface WorkspaceSnapshotOptions {
  readonly ownedRoot: string
  readonly maxFiles: number
  readonly maxBytes: number
  readonly maxBundleBytes: number
  readonly timeoutMs: number
}

/** A clean task-owned authority repository plus its exact self-contained base. */
export interface WorkspaceSnapshot {
  readonly version: 1
  readonly snapshotId: string
  readonly source: string
  readonly workspace: string
  readonly baseSha: string
  readonly baseBundle: string
}

interface Fingerprint {
  readonly kind: 'file' | 'directory' | 'symlink'
  readonly mode: number
  readonly digest?: string
  readonly target?: string
}
interface SnapshotReceipt {
  readonly version: 1
  readonly snapshotId: string
  readonly source: string
  readonly sourceDevice: number
  readonly sourceInode: number
  readonly workspace: string
  readonly baseSha: string
  readonly files: Record<string, Fingerprint>
  readonly state: 'prepared' | 'applying' | 'applied'
  readonly deliveredHead?: string
}

/** Creates private Git checkpoints without changing the user's files, index, refs, or HEAD. */
export class WorkspaceSnapshotManager {
  constructor(private readonly options: WorkspaceSnapshotOptions) {
    if (!isAbsolute(options.ownedRoot)
      || [options.maxFiles, options.maxBytes, options.maxBundleBytes, options.timeoutMs]
        .some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('invalid workspace snapshot bounds')
  }

  /**
   * Capture current files in a task-owned clean repository, including dirty and untracked source bytes.
   * @param source - the registered source directory; it need not have Git metadata or HEAD.
   * @param executionKey - durable caller identity; an existing snapshot is recovered without resampling inputs.
   * @returns the exact base and its self-contained bundle for authenticated remote execution.
   */
  async prepare(source: string, executionKey: string): Promise<WorkspaceSnapshot> {
    if (executionKey.length === 0 || executionKey.trim() !== executionKey) throw new Error('snapshot execution key must be non-blank and trimmed')
    const canonicalSource = await realpath(source)
    const sourceMetadata = await lstat(canonicalSource)
    if (!sourceMetadata.isDirectory()) throw new Error('snapshot source must be a directory')
    const snapshotId = hash(executionKey)
    const directory = join(this.options.ownedRoot, snapshotId)
    const receiptPath = join(directory, 'receipt.json')
    const existing = await optionalFile(receiptPath)
    if (existing !== undefined) {
      const receipt = parseReceipt(JSON.parse(existing.toString('utf8')) as unknown)
      if (receipt.source !== canonicalSource || receipt.snapshotId !== snapshotId) throw new Error('snapshot key conflicts with its original source')
      return this.snapshot(receipt)
    }
    await mkdir(this.options.ownedRoot, { recursive: true, mode: 0o700 })
    if (contains(canonicalSource, await realpath(this.options.ownedRoot))) throw new Error('snapshot metadata must be outside the source directory')
    await mkdir(directory, { mode: 0o700 })
    const workspace = join(directory, 'repository')
    await mkdir(workspace, { mode: 0o700 })
    const files: Record<string, Fingerprint> = {}
    let count = 0
    let bytes = 0
    const visit = async (path: string): Promise<void> => {
      for (const entry of await readdir(join(canonicalSource, path), { withFileTypes: true })) {
        if (entry.name.toLowerCase() === '.git') continue
        const child = path.length === 0 ? entry.name : `${path}/${entry.name}`
        checkedPath(child)
        const sourcePath = join(canonicalSource, child)
        const targetPath = join(workspace, child)
        const fingerprint = await fingerprintAt(sourcePath, this.options.maxBytes)
        if (fingerprint === undefined) throw new Error(`snapshot source changed while reading ${child}`)
        if (++count > this.options.maxFiles) throw new Error(`snapshot exceeds ${String(this.options.maxFiles)} entries`)
        files[child] = fingerprint
        if (fingerprint.kind === 'directory') {
          await mkdir(targetPath)
          await visit(child)
        } else if (fingerprint.kind === 'file') {
          const metadata = await lstat(sourcePath)
          bytes += metadata.size
          if (bytes > this.options.maxBytes) throw new Error(`snapshot exceeds ${String(this.options.maxBytes)} bytes`)
          await copyFile(sourcePath, targetPath)
          await chmod(targetPath, fingerprint.mode)
        } else {
          const linkTarget = fingerprint.target as string
          const absoluteTarget = resolve(dirname(sourcePath), linkTarget)
          if (!contains(canonicalSource, absoluteTarget)
            || relative(canonicalSource, absoluteTarget).split(sep).includes('.git')) {
            throw new Error(`snapshot symlink escapes source files: ${child}`)
          }
          const copiedTarget = join(workspace, relative(canonicalSource, absoluteTarget))
          await symlink(relative(dirname(targetPath), copiedTarget), targetPath)
        }
        if (!same(fingerprint, await fingerprintAt(sourcePath, this.options.maxBytes))) throw new Error(`snapshot source changed while reading ${child}`)
      }
    }
    await visit('')
    const seen = new Set<string>()
    const verifySnapshot = async (path: string): Promise<void> => {
      for (const entry of await readdir(join(canonicalSource, path), { withFileTypes: true })) {
        if (entry.name.toLowerCase() === '.git') continue
        const child = path.length === 0 ? entry.name : `${path}/${entry.name}`
        const actual = await fingerprintAt(join(canonicalSource, child), this.options.maxBytes)
        if (!same(files[child], actual)) throw new Error(`snapshot source changed while reading ${child}`)
        seen.add(child)
        if (actual?.kind === 'directory') await verifySnapshot(child)
      }
    }
    await verifySnapshot('')
    if (seen.size !== Object.keys(files).length) throw new Error('snapshot source entries changed while reading')
    await this.git(workspace, ['init', '--initial-branch=main'])
    await this.git(workspace, ['add', '--force', '--all', '--', '.'])
    await this.git(workspace, ['-c', 'user.name=DSH Snapshot', '-c', 'user.email=dsh-snapshot@local',
      'commit', '--allow-empty', '-m', 'DSH task source snapshot'])
    const baseSha = (await this.git(workspace, ['rev-parse', 'HEAD'])).trim()
    const receipt: SnapshotReceipt = { version: 1, snapshotId, source: canonicalSource,
      sourceDevice: sourceMetadata.dev, sourceInode: sourceMetadata.ino, workspace, baseSha, files, state: 'prepared' }
    await this.writeReceipt(receipt)
    return this.snapshot(receipt)
  }

  /**
   * Export current integrated inputs for the next remote node, including an independent read-only verifier.
   * @param snapshotId - durable source snapshot identity returned by prepare.
   * @param authorityWorkspace - clean task-owned authority repository; defaults to the receipt's workspace.
   * @returns a self-contained bundle bound to the authority's current exact HEAD.
   */
  async captureInput(snapshotId: string, authorityWorkspace?: string): Promise<{ baseSha: string; baseBundle: string }> {
    if (!/^[a-f0-9]{64}$/u.test(snapshotId)) throw new Error('invalid snapshot identity')
    const receipt = parseReceipt(JSON.parse(await readFile(join(this.options.ownedRoot, snapshotId, 'receipt.json'), 'utf8')) as unknown)
    const workspace = authorityWorkspace ?? receipt.workspace
    if (receipt.snapshotId !== snapshotId || await realpath(workspace) !== await realpath(receipt.workspace)) {
      throw new Error('snapshot input requires its task-owned authority repository')
    }
    if ((await this.git(workspace, ['status', '--porcelain=v1', '-uall'])).length > 0) throw new Error('snapshot input requires a clean authority workspace')
    const baseSha = (await this.git(workspace, ['rev-parse', 'HEAD'])).trim()
    const path = join(this.options.ownedRoot, snapshotId, `${baseSha}.bundle`)
    if (await optionalFile(path) === undefined) await this.git(workspace, ['bundle', 'create', path, 'HEAD'])
    const bundle = await readFile(path)
    if (bundle.byteLength > this.options.maxBundleBytes) throw new Error(`snapshot bundle exceeds ${String(this.options.maxBundleBytes)} bytes`)
    return { baseSha, baseBundle: bundle.toString('base64') }
  }

  /**
   * Apply verified committed changes only while every affected source path still matches its snapshot fingerprint.
   * @param snapshotId - durable source snapshot identity returned by prepare.
   * @param verifiedWorkspace - clean authority repository after independent verification and integration.
   * @returns the changed source paths; a previously completed delivery is not applied twice.
   * @throws Error - on source drift or an unresolved partial delivery; the source index and HEAD are never touched.
   */
  async conditionalApply(snapshotId: string, verifiedWorkspace: string): Promise<readonly string[]> {
    if (!/^[a-f0-9]{64}$/u.test(snapshotId)) throw new Error('invalid snapshot identity')
    const receipt = parseReceipt(JSON.parse(await readFile(join(this.options.ownedRoot, snapshotId, 'receipt.json'), 'utf8')) as unknown)
    if (receipt.snapshotId !== snapshotId || receipt.workspace !== join(this.options.ownedRoot, snapshotId, 'repository')) {
      throw new Error('snapshot receipt identity mismatch')
    }
    const sourceMetadata = await lstat(receipt.source)
    if (!sourceMetadata.isDirectory() || sourceMetadata.dev !== receipt.sourceDevice || sourceMetadata.ino !== receipt.sourceInode) {
      throw new Error('snapshot source directory identity changed')
    }
    const head = (await this.git(verifiedWorkspace, ['rev-parse', 'HEAD'])).trim()
    if (receipt.state === 'applied') {
      if (receipt.deliveredHead !== head) throw new Error('snapshot already delivered a different verified result')
      return []
    }
    if (receipt.state === 'applying') throw new SnapshotDeliveryIndeterminateError('snapshot delivery outcome is indeterminate; reconcile the original delivery')
    if ((await this.git(verifiedWorkspace, ['status', '--porcelain=v1', '-uall'])).length > 0) throw new Error('delivery requires a clean verified workspace')
    if ((await this.git(verifiedWorkspace, ['rev-parse', `${receipt.baseSha}^{commit}`])).trim() !== receipt.baseSha) {
      throw new Error('verified workspace lacks the exact snapshot base')
    }
    const names = (await this.git(verifiedWorkspace, ['diff', '--name-only', '--no-renames', '-z', receipt.baseSha, head, '--']))
      .split('\0').filter(Boolean)
    for (const path of names) checkedPath(path)
    const changes = await Promise.all(names.map(async path => ({
      path, target: await fingerprintAt(join(verifiedWorkspace, path), this.options.maxBytes),
    })))
    for (const change of changes) {
      await this.expectSource(receipt, change.path)
      for (let parent = dirname(change.path); parent !== '.'; parent = dirname(parent)) {
        const expected = receipt.files[parent]
        const actual = await fingerprintAt(join(receipt.source, parent), this.options.maxBytes)
        if (!same(expected, actual)) throw new Error(`source parent changed since snapshot: ${parent}`)
        if (actual?.kind !== undefined && actual.kind !== 'directory') throw new Error(`source parent is not a directory: ${parent}`)
      }
      const previous = receipt.files[change.path]
      if (previous?.kind === 'directory' || change.target?.kind === 'directory') throw new Error(`directory replacement is unsupported: ${change.path}`)
      if (change.target?.kind === 'symlink') {
        const destination = resolve(dirname(join(receipt.source, change.path)), change.target.target as string)
        if (!contains(receipt.source, destination)) throw new Error(`result symlink escapes source: ${change.path}`)
      }
    }
    await this.writeReceipt({ ...receipt, state: 'applying', deliveredHead: head })
    try {
      for (const change of changes) {
        await this.expectSource(receipt, change.path)
        const destination = join(receipt.source, change.path)
        if (change.target === undefined) {
          await rm(destination)
        } else {
          await mkdir(dirname(destination), { recursive: true })
          const temporary = join(dirname(destination), `.dsh-delivery-${randomUUID()}`)
          if (change.target.kind === 'symlink') await symlink(change.target.target as string, temporary)
          else {
            await copyFile(join(verifiedWorkspace, change.path), temporary)
            const originalMode = receipt.files[change.path]?.mode
            const mode = originalMode === undefined ? change.target.mode : (originalMode & ~0o111) | (change.target.mode & 0o111)
            await chmod(temporary, mode)
          }
          if (!same(receipt.files[change.path], await fingerprintAt(destination, this.options.maxBytes))) {
            await rm(temporary)
            throw new Error(`source changed during delivery: ${change.path}`)
          }
          await rename(temporary, destination)
        }
      }
      await this.writeReceipt({ ...receipt, state: 'applied', deliveredHead: head })
      return names
    } catch (cause) {
      throw new SnapshotDeliveryIndeterminateError('snapshot delivery outcome is indeterminate after delivery began', { cause })
    }
  }

  private async expectSource(receipt: SnapshotReceipt, path: string): Promise<void> {
    if (!same(receipt.files[path], await fingerprintAt(join(receipt.source, path), this.options.maxBytes))) throw new Error(`source changed since snapshot: ${path}`)
  }

  private async snapshot(receipt: SnapshotReceipt): Promise<WorkspaceSnapshot> {
    const bundlePath = join(dirname(receipt.workspace), 'base.bundle')
    if (await optionalFile(bundlePath) === undefined) await this.git(receipt.workspace, ['bundle', 'create', bundlePath, receipt.baseSha, 'refs/heads/main'])
    const bundle = await readFile(bundlePath)
    if (bundle.byteLength > this.options.maxBundleBytes) throw new Error(`snapshot bundle exceeds ${String(this.options.maxBundleBytes)} bytes`)
    return { version: 1, snapshotId: receipt.snapshotId, source: receipt.source, workspace: receipt.workspace,
      baseSha: receipt.baseSha, baseBundle: bundle.toString('base64') }
  }

  private async writeReceipt(receipt: SnapshotReceipt): Promise<void> {
    const path = join(this.options.ownedRoot, receipt.snapshotId, 'receipt.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
    const result = await execute('git', ['-c', `core.hooksPath=${nullFile}`, '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', timeout: this.options.timeoutMs,
      maxBuffer: this.options.maxBytes, env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile } })
    return result.stdout
  }
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
function checkedPath(path: string): void {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')
    || path.split('/').some(value => value === '' || value === '.' || value === '..' || value.toLowerCase() === '.git')) throw new Error('invalid snapshot file path')
}
async function optionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function fingerprintAt(path: string, maxBytes: number): Promise<Fingerprint | undefined> {
  let metadata
  try { metadata = await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const mode = metadata.mode & 0o777
  if (metadata.isSymbolicLink()) return { kind: 'symlink', mode, target: await readlink(path) }
  if (metadata.isDirectory()) return { kind: 'directory', mode }
  if (!metadata.isFile()) throw new Error(`unsupported snapshot filesystem entry: ${path}`)
  if (metadata.size > maxBytes) throw new Error(`snapshot file exceeds ${String(maxBytes)} bytes: ${path}`)
  return { kind: 'file', mode, digest: hash(await readFile(path)) }
}
function same(first: Fingerprint | undefined, second: Fingerprint | undefined): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}
function parseReceipt(value: unknown): SnapshotReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid snapshot receipt')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.snapshotId !== 'string' || !/^[a-f0-9]{64}$/u.test(record.snapshotId)
    || typeof record.source !== 'string' || !isAbsolute(record.source)
    || !Number.isSafeInteger(record.sourceDevice) || !Number.isSafeInteger(record.sourceInode)
    || typeof record.workspace !== 'string' || !isAbsolute(record.workspace)
    || typeof record.baseSha !== 'string' || !/^[a-f0-9]{40}$/u.test(record.baseSha)
    || record.files === null || typeof record.files !== 'object' || Array.isArray(record.files)
    || !['prepared', 'applying', 'applied'].includes(String(record.state))) throw new Error('invalid snapshot receipt')
  for (const [path, raw] of Object.entries(record.files as Record<string, unknown>)) {
    checkedPath(path)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid snapshot fingerprint')
    const fingerprint = raw as Record<string, unknown>
    if (!['file', 'directory', 'symlink'].includes(String(fingerprint.kind)) || !Number.isSafeInteger(fingerprint.mode)
      || (fingerprint.mode as number) < 0 || (fingerprint.mode as number) > 0o777
      || (fingerprint.kind === 'file' && (typeof fingerprint.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint.digest)))
      || (fingerprint.kind === 'symlink' && typeof fingerprint.target !== 'string')) throw new Error('invalid snapshot fingerprint')
  }
  return value as SnapshotReceipt
}
