import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CasRef {
  readonly ref: `sha256:${string}`
  readonly path: string
  readonly bytes: number
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8')
}

export function contentSha256(data: Uint8Array): string {
  return sha256(data)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    const handle = await open(path, 'r')
    await handle.chmod(0o700)
    await handle.close()
  } catch {
    // The mkdir mode is the important boundary. A chmod failure is surfaced
    // by the subsequent artifact write when the platform does not allow it.
  }
}

/** Write immutable bytes under a content address and return its stable ref. */
export async function writeCas(root: string, data: Uint8Array): Promise<CasRef> {
  const digest = sha256(data)
  const directory = join(root, 'artifacts', 'sha256')
  const target = join(directory, digest)
  await ensurePrivateDirectory(directory)
  try {
    await writeFile(target, data, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return { ref: `sha256:${digest}`, path: target, bytes: data.byteLength }
}

/** Read one local CAS object after the caller has already validated its ref. */
export async function readCas(root: string, ref: `sha256:${string}`): Promise<Buffer> {
  const digest = ref.slice('sha256:'.length)
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('invalid Archify content address')
  return readFile(join(root, 'artifacts', 'sha256', digest))
}

/** Atomically publish a named delivery projection next to its CAS artifact. */
export async function publishDelivery(root: string, name: string, data: Uint8Array): Promise<string> {
  const directory = join(root, 'deliveries')
  await ensurePrivateDirectory(directory)
  const target = join(directory, name)
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return target
}

export function artifactRootForWorkspace(workspace: string, configured?: string): string {
  return configured === undefined || configured.trim() === ''
    ? join(workspace, '.dsh-archify')
    : configured.startsWith('/') ? configured : join(workspace, configured)
}

export function boundedText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= maxBytes) return value
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[truncated]`
}

export function isContainedPath(root: string, candidate: string): boolean {
  const relative = candidate === root ? '' : candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : undefined
  return relative !== undefined && relative !== '' && !relative.split('/').includes('..')
}
