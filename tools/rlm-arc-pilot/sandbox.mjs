import { dirname, isAbsolute, relative, resolve } from 'node:path'

const SYSTEM_WRITE_EXCEPTIONS = ['/dev/null', '/dev/random', '/dev/urandom']

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`)
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    fail('ARC_SANDBOX_PATH', `${label} must be a non-empty absolute path`)
  }
  return resolve(value)
}

function isSameOrDescendant(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

function sbpl(value) {
  return JSON.stringify(value)
}

function normalizedRoots(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('ARC_SANDBOX_ROOTS', `${label} must be an array`)
  const output = []
  for (const item of value) {
    const root = absolutePath(item, `${label} item`)
    if (root === '/' || root === '/Users' || root === '/private/tmp') {
      fail('ARC_SANDBOX_ROOTS', `${label} may not contain a broad root: ${root}`)
    }
    if (!output.includes(root)) output.push(root)
  }
  return output
}

function normalizedProtectedRoots(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('ARC_SANDBOX_PROTECTED', 'protectedRoots must be an array')
  const output = []
  for (const item of value) {
    const raw = typeof item === 'string' ? item : item?.path
    const root = absolutePath(raw, 'protectedRoots item')
    if (!output.includes(root)) output.push(root)
  }
  return output
}

function denySubpathWithExceptions(operation, root, exceptions) {
  const terms = [`(subpath ${sbpl(root)})`]
  for (const exception of exceptions) terms.push(`(require-not (subpath ${sbpl(exception)}))`)
  return `(deny ${operation} (require-all ${terms.join(' ')}))`
}

// Node resolves an entry module and external package through every ancestor
// with lstat/realpath before opening the permitted leaf. Permit metadata only
// on those exact ancestors; the data and subdirectory-metadata denies below
// still fence corpus, provider and other-run contents.
function metadataAncestors(paths) {
  const output = new Set()
  for (const path of paths) {
    let current = path
    while (current !== '/') {
      output.add(current)
      current = dirname(current)
    }
  }
  return [...output].sort((left, right) => left.length - right.length || left.localeCompare(right))
}

/**
 * Render the macOS sandbox profile for one untrusted ARC arm worker.
 *
 * The worker owns only `directory`. `shared` and `readRoots` are read-only
 * inputs. We deliberately use the platform's accepted `localhost:<port>`
 * syntax for the TCP rule; the parent also binds the bridge itself to
 * 127.0.0.1 and reserves ::1 at the same port. macOS SBPL rejects numeric
 * hosts in `remote tcp` filters ("host must be * or localhost").
 */
export function policy({
  directory,
  shared,
  readRoots = [],
  bridgePort,
  brokerPrivateRoot,
  protectedRoots = [],
} = {}) {
  const runDirectory = absolutePath(directory, 'directory')
  const sharedDirectory = absolutePath(shared, 'shared')
  const roots = normalizedRoots(readRoots, 'readRoots')
  const protectedPaths = normalizedProtectedRoots(protectedRoots)
  const brokerRoot = brokerPrivateRoot === undefined ? undefined : absolutePath(brokerPrivateRoot, 'brokerPrivateRoot')

  if (!Number.isSafeInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    fail('ARC_SANDBOX_PORT', 'bridgePort must be an integer from 1 to 65535')
  }
  if (runDirectory === sharedDirectory || isSameOrDescendant(sharedDirectory, runDirectory)) {
    fail('ARC_SANDBOX_LAYOUT', 'shared must be outside the writable run directory')
  }
  for (const root of roots) {
    if (isSameOrDescendant(root, runDirectory)) fail('ARC_SANDBOX_LAYOUT', 'readRoots must not overlap the writable run directory')
    if (protectedPaths.some(protectedRoot => isSameOrDescendant(root, protectedRoot) || isSameOrDescendant(protectedRoot, root))) {
      fail('ARC_SANDBOX_LAYOUT', `read root overlaps a protected root: ${root}`)
    }
  }
  if (brokerRoot && (isSameOrDescendant(brokerRoot, runDirectory) || isSameOrDescendant(brokerRoot, sharedDirectory))) {
    fail('ARC_SANDBOX_LAYOUT', 'brokerPrivateRoot must not overlap worker-visible paths')
  }

  const readable = [runDirectory, sharedDirectory, ...roots]
  const usersExceptions = readable.filter(path => isSameOrDescendant(path, '/Users'))
  const tmpExceptions = readable.filter(path => isSameOrDescendant(path, '/private/tmp'))
  const metadataRoots = metadataAncestors(readable)
  const ownData = resolve(runDirectory, 'data')
  const ownTmp = resolve(runDirectory, 'tmp')
  const guardSocket = resolve(runDirectory, 'guard.sock')
  const profile = [
    '(version 1)',
    // We begin from the host's normal execution surface, then fence exactly
    // the file and outbound channels that carry corpus, scoring and provider
    // state. This avoids pretending that a reconstructed minimal Darwin
    // runtime profile is complete.
    '(allow default)',
    denySubpathWithExceptions('file-read-data', '/Users', usersExceptions),
    denySubpathWithExceptions('file-read-metadata', '/Users', usersExceptions),
    denySubpathWithExceptions('file-read-data', '/private/tmp', tmpExceptions),
    denySubpathWithExceptions('file-read-metadata', '/private/tmp', tmpExceptions),
    `(allow file-read-metadata ${metadataRoots.map(path => `(literal ${sbpl(path)})`).join(' ')})`,
    ...protectedPaths.flatMap(path => [
      `(deny file-read* (subpath ${sbpl(path)}))`,
      `(deny file-write* (subpath ${sbpl(path)}))`,
    ]),
    ...(brokerRoot === undefined ? [] : [
      `(deny file-read* (subpath ${sbpl(brokerRoot)}))`,
      `(deny file-write* (subpath ${sbpl(brokerRoot)}))`,
    ]),
    `(deny file-write* (require-all (require-not (subpath ${sbpl(runDirectory)})) ${SYSTEM_WRITE_EXCEPTIONS.map(path => `(require-not (literal ${sbpl(path)}))`).join(' ')}))`,
    '(deny network-outbound)',
    `(allow network-outbound (remote tcp ${sbpl(`localhost:${bridgePort}`)}))`,
    `(allow network-outbound (remote unix-socket (path-literal ${sbpl(guardSocket)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${sbpl(ownData)})))`,
    // Prime's daemon derives its own per-worker Unix socket below TMPDIR.
    // TMPDIR is the worker's run-local tmp directory, never global /tmp.
    `(allow network-outbound (remote unix-socket (subpath ${sbpl(ownTmp)})))`,
    '',
  ]
  return profile.join('\n')
}

export const SBPL_TCP_HOST_LIMITATION = 'macOS sandbox-exec accepts localhost:<port> for remote tcp and rejects numeric 127.0.0.1 hosts; the parent bridge must bind 127.0.0.1 and reserve ::1 at the same port.'
