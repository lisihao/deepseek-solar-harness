import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const TAR = '/usr/bin/tar'
const COMPLETE_MARKER = 'complete.json'
const BINARY_PATH = 'prime/prime-agent'
const PYTHON_PATH = 'python/bin/python3'
const PACKAGE_MANIFEST_PATH = 'prime/package.json'
const SHA256 = /^[a-f0-9]{64}$/

export const PRIME_COMMIT = '7cbffa77b38facd7c87277fa3c82bcadbe816880'

export interface RuntimePaths {
  readonly binary: string
  readonly python: string
  readonly packageDir: string
  readonly fingerprint: string
}

export interface RuntimeManifest {
  readonly formatVersion: 1
  readonly platform: 'darwin'
  readonly arch: 'arm64'
  readonly primeCommit: string
  readonly archiveSha256: string
  readonly binarySha256: string
  readonly pythonVersion: string
  readonly criticalFiles: Readonly<Record<string, string>>
  readonly sourceEvidence?: unknown
  readonly packageLayout?: unknown
}

interface JsonObject {
  readonly [key: string]: unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function error(code: string, message: string, cause?: unknown): Error {
  return new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  const pieces = value.split('/')
  if (pieces.some((piece) => piece.length === 0 || piece === '.' || piece === '..')) return false
  return posix.normalize(value) === value
}

function normalizeArchivePath(value: string): string {
  let path = value
  while (path.startsWith('./')) path = path.slice(2)
  if (path.endsWith('/')) path = path.slice(0, -1)
  if (path === '') return ''
  if (!isSafeRelativePath(path)) throw error('RLM_RUNTIME_ARCHIVE', `归档成员路径无效：${value}`)
  return path
}

function within(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result.length > 0 && result !== '..' && !result.startsWith('../') && !isAbsolute(result)
}

export async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function validateManifest(value: unknown): RuntimeManifest {
  if (!isObject(value)) throw error('RLM_RUNTIME_UNSUPPORTED', '运行时清单必须是对象。')
  const allowed = new Set(['formatVersion', 'platform', 'arch', 'primeCommit', 'archiveSha256', 'binarySha256', 'pythonVersion', 'criticalFiles', 'sourceEvidence', 'packageLayout'])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw error('RLM_RUNTIME_UNSUPPORTED', `运行时清单包含未知字段：${unknown.join(', ')}`)
  if (value.formatVersion !== 1 || value.platform !== 'darwin' || value.arch !== 'arm64' || process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw error('RLM_RUNTIME_UNSUPPORTED', '运行时格式、平台或架构不受支持。')
  }
  if (value.primeCommit !== PRIME_COMMIT) throw error('RLM_RUNTIME_UNSUPPORTED', 'Prime 来源提交不匹配。')
  if (typeof value.archiveSha256 !== 'string' || !SHA256.test(value.archiveSha256)) throw error('RLM_RUNTIME_UNSUPPORTED', 'archiveSha256 不是有效 SHA-256。')
  if (typeof value.binarySha256 !== 'string' || !SHA256.test(value.binarySha256)) throw error('RLM_RUNTIME_UNSUPPORTED', 'binarySha256 不是有效 SHA-256。')
  if (typeof value.pythonVersion !== 'string' || value.pythonVersion.trim().length === 0) throw error('RLM_RUNTIME_UNSUPPORTED', 'pythonVersion 不能为空。')
  if (!isObject(value.criticalFiles) || Object.keys(value.criticalFiles).length === 0) throw error('RLM_RUNTIME_UNSUPPORTED', 'criticalFiles 必须是非空对象。')

  const criticalFiles: Record<string, string> = {}
  for (const [path, checksum] of Object.entries(value.criticalFiles)) {
    if (!isSafeRelativePath(path) || typeof checksum !== 'string' || !SHA256.test(checksum)) {
      throw error('RLM_RUNTIME_UNSUPPORTED', `criticalFiles 含有无效条目：${path}`)
    }
    criticalFiles[path] = checksum
  }
  if (criticalFiles[BINARY_PATH] !== value.binarySha256) throw error('RLM_RUNTIME_UNSUPPORTED', 'binarySha256 与 criticalFiles 不一致。')
  if (!(PYTHON_PATH in criticalFiles)) throw error('RLM_RUNTIME_UNSUPPORTED', 'criticalFiles 缺少 Python 可执行文件。')
  if (!(PACKAGE_MANIFEST_PATH in criticalFiles)) throw error('RLM_RUNTIME_UNSUPPORTED', 'criticalFiles 缺少 Prime package.json。')

  return {
    formatVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    primeCommit: value.primeCommit,
    archiveSha256: value.archiveSha256,
    binarySha256: value.binarySha256,
    pythonVersion: value.pythonVersion,
    criticalFiles,
    ...(Object.hasOwn(value, 'sourceEvidence') ? { sourceEvidence: value.sourceEvidence } : {}),
    ...(Object.hasOwn(value, 'packageLayout') ? { packageLayout: value.packageLayout } : {}),
  }
}

async function readManifest(path: string): Promise<RuntimeManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (cause) {
    throw error('RLM_RUNTIME_UNSUPPORTED', '运行时清单无法解析。', cause)
  }
  return validateManifest(parsed)
}

function archiveMemberFromVerboseLine(line: string, entries: readonly string[]): string | undefined {
  const body = line.split(' -> ', 1)[0] ?? line
  return entries.find((entry) => body.endsWith(entry) || body.endsWith(`${entry}/`) || body.endsWith(`./${entry}`) || body.endsWith(`./${entry}/`))
}

async function inspectArchive(archive: string): Promise<void> {
  let listed: string
  let verbose: string
  try {
    listed = (await exec(TAR, ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
    verbose = (await exec(TAR, ['-tvzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (cause) {
    throw error('RLM_RUNTIME_ARCHIVE', '运行时归档无法读取。', cause)
  }

  const entries = new Set<string>()
  for (const raw of listed.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const entry = normalizeArchivePath(raw)
    if (entry.length > 0) {
      if (entries.has(entry)) throw error('RLM_RUNTIME_ARCHIVE', `归档成员重复：${entry}`)
      entries.add(entry)
    }
  }

  const sortedEntries = [...entries].sort((a, b) => b.length - a.length)
  for (const line of verbose.split('\n').map((value) => value.trimEnd()).filter(Boolean)) {
    const type = line[0]
    if (type !== '-' && type !== 'd' && type !== 'l') throw error('RLM_RUNTIME_ARCHIVE', '归档包含不支持的特殊文件。')
    const member = archiveMemberFromVerboseLine(line, sortedEntries)
    if (member === undefined) {
      if (line.trimEnd().endsWith('./')) continue
      throw error('RLM_RUNTIME_ARCHIVE', '归档成员清单无法解析。')
    }
    if (type === 'l') {
      const marker = line.indexOf(' -> ')
      const destination = marker === -1 ? '' : line.slice(marker + 4).trim()
      if (destination.length === 0 || destination.startsWith('/') || /^[A-Za-z]:[\\/]/.test(destination)) {
        throw error('RLM_RUNTIME_ARCHIVE', `归档链接目标无效：${member}`)
      }
      const resolved = posix.normalize(posix.join(posix.dirname(member), destination))
      if (!isSafeRelativePath(resolved)) throw error('RLM_RUNTIME_ARCHIVE', `归档链接越界：${member}`)
    }
  }
}

async function assertCriticalFiles(root: string, manifest: RuntimeManifest, checkExecutables = true): Promise<void> {
  for (const [relativePath, expected] of Object.entries(manifest.criticalFiles)) {
    const path = join(root, relativePath)
    let metadata
    try {
      metadata = await lstat(path)
    } catch (cause) {
      throw error(relativePath === BINARY_PATH ? 'RLM_RUNTIME_BINARY' : relativePath === PYTHON_PATH ? 'RLM_RUNTIME_PYTHON' : 'RLM_RUNTIME_CRITICAL', `运行时关键文件缺失：${relativePath}`, cause)
    }
    if (metadata.isSymbolicLink()) {
      let target: string
      try { target = await realpath(path) } catch (cause) { throw error('RLM_RUNTIME_CRITICAL', `运行时链接无法解析：${relativePath}`, cause) }
      if (!within(await realpath(root), target)) throw error('RLM_RUNTIME_CRITICAL', `运行时链接越出目标目录：${relativePath}`)
      metadata = await stat(path)
    }
    if (!metadata.isFile()) throw error('RLM_RUNTIME_CRITICAL', `运行时关键路径不是文件：${relativePath}`)
    if (checkExecutables && (relativePath === BINARY_PATH || relativePath === PYTHON_PATH) && (metadata.mode & 0o111) === 0) {
      throw error(relativePath === BINARY_PATH ? 'RLM_RUNTIME_BINARY' : 'RLM_RUNTIME_PYTHON', `运行时可执行文件没有执行权限：${relativePath}`)
    }
    let actual: string
    try { actual = await digest(path) } catch (cause) { throw error('RLM_RUNTIME_CRITICAL', `运行时关键文件无法读取：${relativePath}`, cause) }
    if (actual !== expected) {
      throw error(relativePath === BINARY_PATH ? 'RLM_RUNTIME_BINARY' : relativePath === PYTHON_PATH ? 'RLM_RUNTIME_PYTHON' : 'RLM_RUNTIME_CRITICAL', `运行时关键文件校验失败：${relativePath}`)
    }
  }
}

async function assertComplete(root: string, manifest: RuntimeManifest): Promise<void> {
  let rootMetadata
  try { rootMetadata = await lstat(root) } catch (cause) { throw error('RLM_RUNTIME_MARKER', '运行时目标目录不存在。', cause) }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw error('RLM_RUNTIME_MARKER', '运行时目标不是普通目录。')
  let marker: string
  try {
    marker = await readFile(join(root, COMPLETE_MARKER), 'utf8')
  } catch (cause) {
    throw error('RLM_RUNTIME_MARKER', '运行时原子完成标记缺失。', cause)
  }
  let value: unknown
  try { value = JSON.parse(marker) as unknown } catch (cause) { throw error('RLM_RUNTIME_MARKER', '运行时完成标记无法解析。', cause) }
  if (canonicalJson(value) !== canonicalJson(manifest)) throw error('RLM_RUNTIME_MARKER', '运行时完成标记与清单不一致。')
  await assertCriticalFiles(root, manifest)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}

export async function loadRuntime(packageRoot: string, dataRoot: string): Promise<RuntimePaths> {
  const manifest = await readManifest(join(packageRoot, 'assets/runtime-manifest.json'))
  const fingerprint = manifest.archiveSha256
  const runtimesRoot = join(dataRoot, 'runtimes')
  const target = join(runtimesRoot, fingerprint)
  const result: RuntimePaths = { binary: join(target, BINARY_PATH), python: join(target, PYTHON_PATH), packageDir: join(target, 'prime'), fingerprint }

  if (await exists(target)) {
    await assertComplete(target, manifest)
    return result
  }

  const archive = join(packageRoot, 'assets/runtime.tar.gz')
  let archiveDigest: string
  try { archiveDigest = await digest(archive) } catch (cause) { throw error('RLM_RUNTIME_DIGEST', '运行时归档无法读取。', cause) }
  if (archiveDigest !== fingerprint) throw error('RLM_RUNTIME_DIGEST', '运行时压缩包校验失败。')
  await inspectArchive(archive)
  await mkdir(runtimesRoot, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(runtimesRoot, `.${fingerprint}.tmp-`))
  let published = false
  try {
    try {
      await exec(TAR, ['-xzf', archive, '-C', temporary], { maxBuffer: 16 * 1024 * 1024 })
    } catch (cause) {
      throw error('RLM_RUNTIME_ARCHIVE', '运行时归档解包失败。', cause)
    }
    await assertCriticalFiles(temporary, manifest, false)
    await chmod(join(temporary, BINARY_PATH), 0o755)
    await writeFile(join(temporary, COMPLETE_MARKER), `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (await exists(target)) throw error('RLM_RUNTIME_MARKER', '运行时目标在发布前已存在，拒绝覆盖。')
    await rename(temporary, target)
    published = true
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true })
  }
  await assertComplete(target, manifest)
  return result
}
