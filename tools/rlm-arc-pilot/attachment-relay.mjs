import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const ATTACHMENT_PACKAGE = '@deepseek-ai/dsh-attachment-local'
const ATTACHMENT_VERSION = '0.2.1-rc.2'
const ATTACHMENT_DIR_PREFIX = '@deepseek-ai+dsh-attachment-local@0.2.1-rc.2'
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_IMAGE_BYTES = 32 * 1024 * 1024
const ATTACHMENT_KEYS = new Set(['kind', 'mediaType', 'dataBase64', 'sha256', 'bytes'])

function relayError(code, message, options = {}) {
  const error = new Error(`${code}: ${message}`, options)
  error.code = code
  return error
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw relayError('ARC_ATTACHMENT_RELAY_ARGS', `${name} must be an absolute path`)
  }
  return resolve(value)
}

async function readPackageIdentity(packageRoot) {
  const packageJsonPath = join(packageRoot, 'package.json')
  let packageJson
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  } catch (error) {
    return undefined
  }
  if (packageJson?.name !== ATTACHMENT_PACKAGE || packageJson?.version !== ATTACHMENT_VERSION) return undefined
  try {
    const packageStat = await stat(join(packageRoot, 'lib', 'index.js'))
    if (!packageStat.isFile()) return undefined
  } catch {
    return undefined
  }
  return { packageRoot, name: packageJson.name, version: packageJson.version }
}

async function findAttachmentPackage(sourceRoot) {
  const pnpmRoot = join(sourceRoot, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await readdir(pnpmRoot, { withFileTypes: true })
  } catch (error) {
    throw relayError('ARC_ATTACHMENT_DEPENDENCY_MISSING', `cannot enumerate ${pnpmRoot}`, { cause: error })
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(ATTACHMENT_DIR_PREFIX)) continue
    const packageRoot = join(pnpmRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh-attachment-local')
    const identity = await readPackageIdentity(packageRoot)
    if (!identity) {
      throw relayError('ARC_ATTACHMENT_DEPENDENCY_MISMATCH', `${packageRoot} does not declare ${ATTACHMENT_PACKAGE}@${ATTACHMENT_VERSION}`)
    }
    candidates.push(identity)
  }
  if (candidates.length === 0) {
    throw relayError('ARC_ATTACHMENT_DEPENDENCY_MISSING', `no ${ATTACHMENT_PACKAGE}@${ATTACHMENT_VERSION} package under ${pnpmRoot}`)
  }

  const realCandidates = []
  for (const candidate of candidates) {
    const path = await realpath(candidate.packageRoot)
    if (!realCandidates.some(item => item.path === path)) realCandidates.push({ ...candidate, path })
  }
  // Multiple pnpm peer-resolution directories are acceptable only when every
  // validated candidate is the same fixed package identity.  The sort makes
  // selection deterministic without consulting a registry or installing.
  const identities = new Set(realCandidates.map(item => `${item.name}@${item.version}`))
  if (identities.size !== 1) {
    throw relayError('ARC_ATTACHMENT_DEPENDENCY_AMBIGUOUS', `multiple package identities matched ${ATTACHMENT_PACKAGE}`)
  }
  realCandidates.sort((left, right) => left.path.localeCompare(right.path))
  return realCandidates[0].path
}

async function loadAttachmentRuntime(sourceRoot) {
  const packageRoot = await findAttachmentPackage(sourceRoot)
  let attachmentModule
  let cordisModule
  try {
    attachmentModule = await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)
    // Import Cordis from the fixed package's own dependency closure.  This
    // avoids relying on a root-level link and keeps the store/context pair.
    const peerRoot = resolve(packageRoot, '..', '..')
    cordisModule = await import(pathToFileURL(join(peerRoot, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
  } catch (error) {
    throw relayError('ARC_ATTACHMENT_DEPENDENCY_IMPORT', `cannot import ${ATTACHMENT_PACKAGE}@${ATTACHMENT_VERSION}`, { cause: error })
  }
  const LocalAttachmentStore = attachmentModule.LocalAttachmentStore ?? attachmentModule.default
  const Context = cordisModule.Context
  if (typeof LocalAttachmentStore !== 'function' || typeof Context !== 'function') {
    throw relayError('ARC_ATTACHMENT_DEPENDENCY_IMPORT', 'fixed attachment package did not expose LocalAttachmentStore and Cordis Context')
  }
  return { packageRoot, LocalAttachmentStore, Context }
}

function validateCanonicalBase64(value, path, maxBytes = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
  }
  let firstPadding = -1
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const alphabet = code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39 || code === 0x2b || code === 0x2f
    if (code === 0x3d) {
      firstPadding = firstPadding === -1 ? index : firstPadding
      if (index < value.length - 2) throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
    } else if (!alphabet || firstPadding !== -1) {
      throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
    }
  }
  if (firstPadding !== -1) {
    const padding = value.length - firstPadding
    if (padding > 2 || padding === 1 && firstPadding % 4 !== 3 || padding === 2 && firstPadding % 4 !== 2) {
      throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
    }
  }
  const padding = firstPadding === -1 ? 0 : value.length - firstPadding
  const decodedBytes = value.length / 4 * 3 - padding
  if (decodedBytes <= 0) throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
  if (decodedBytes > maxBytes) throw relayError('ARC_ATTACHMENT_SIZE', `${path} decodes to more than 8 MiB`)
  const data = Buffer.from(value, 'base64')
  if (data.length === 0 || data.toString('base64') !== value) {
    throw relayError('ARC_ATTACHMENT_BASE64', `${path} must be canonical base64`)
  }
  return data
}

function validatePlaceholder(attachment, path, totalBytes) {
  if (!isRecord(attachment)) {
    throw relayError('ARC_ATTACHMENT_SHAPE', `${path} must be an ipc-inline-image-v1 object`)
  }
  for (const key of Object.keys(attachment)) {
    if (!ATTACHMENT_KEYS.has(key)) throw relayError('ARC_ATTACHMENT_SHAPE', `${path} has unknown field ${JSON.stringify(key)}`)
  }
  if (attachment.kind !== 'ipc-inline-image-v1') throw relayError('ARC_ATTACHMENT_SHAPE', `${path}.kind is unsupported`)
  if (!MEDIA_TYPES.has(attachment.mediaType)) throw relayError('ARC_ATTACHMENT_MEDIA_TYPE', `${path}.mediaType is unsupported`)
  if (!Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0) throw relayError('ARC_ATTACHMENT_BYTES', `${path}.bytes must be a positive integer`)
  if (attachment.bytes > MAX_IMAGE_BYTES) throw relayError('ARC_ATTACHMENT_SIZE', `${path}.bytes exceeds 8 MiB`)
  if (typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.sha256)) {
    throw relayError('ARC_ATTACHMENT_HASH', `${path}.sha256 must be lowercase SHA-256 hex`)
  }
  const data = validateCanonicalBase64(attachment.dataBase64, `${path}.dataBase64`, MAX_IMAGE_BYTES)
  if (data.byteLength !== attachment.bytes) {
    throw relayError('ARC_ATTACHMENT_BYTES', `${path}.bytes does not match decoded byte length`)
  }
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== attachment.sha256) throw relayError('ARC_ATTACHMENT_HASH', `${path}.sha256 does not match decoded bytes`)
  const nextTotal = totalBytes + data.byteLength
  if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_REQUEST_IMAGE_BYTES) {
    throw relayError('ARC_ATTACHMENT_TOTAL_SIZE', 'decoded images exceed the 32 MiB request aggregate')
  }
  return { data, mediaType: attachment.mediaType, bytes: data.byteLength, totalBytes: nextTotal }
}

function scanOptions(options) {
  if (!isRecord(options)) throw relayError('ARC_ATTACHMENT_OPTIONS', 'options must be an object')
  if (options.messages === undefined) return { entries: [], messages: undefined }
  if (!Array.isArray(options.messages)) throw relayError('ARC_ATTACHMENT_OPTIONS', 'options.messages must be an array')
  const entries = []
  let totalBytes = 0
  const collect = (messageIndex, partIndex, part, path) => {
    const image = validatePlaceholder(part.attachment, `${path}.attachment`, totalBytes)
    totalBytes = image.totalBytes
    entries.push({ messageIndex, partIndex, part, image })
  }
  for (let messageIndex = 0; messageIndex < options.messages.length; messageIndex += 1) {
    const message = options.messages[messageIndex]
    if (!isRecord(message) || message.content === undefined) continue
    const content = message.content
    if (Array.isArray(content)) {
      for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
        const part = content[partIndex]
        if (!isRecord(part)) continue
        if (part.type === 'image') {
          if (!own(part, 'attachment')) throw relayError('ARC_ATTACHMENT_SHAPE', `messages[${messageIndex}].content[${partIndex}].attachment is required`)
          collect(messageIndex, partIndex, part, `messages[${messageIndex}].content[${partIndex}]`)
        } else if (part.type === 'image_url') {
          throw relayError('ARC_ATTACHMENT_REMOTE_URL', `messages[${messageIndex}].content[${partIndex}] remote image URLs are not accepted`)
        }
      }
    } else if (isRecord(content)) {
      if (content.type === 'image') {
        if (!own(content, 'attachment')) throw relayError('ARC_ATTACHMENT_SHAPE', `messages[${messageIndex}].content.attachment is required`)
        collect(messageIndex, null, content, `messages[${messageIndex}].content`)
      } else if (content.type === 'image_url') {
        throw relayError('ARC_ATTACHMENT_REMOTE_URL', `messages[${messageIndex}].content remote image URLs are not accepted`)
      }
    }
  }
  return { entries, messages: options.messages }
}

function restoreMessages(messages, entries) {
  if (entries.length === 0) return messages
  const byLocation = new Map(entries.map((entry, index) => [`${entry.messageIndex}:${entry.partIndex === null ? 'object' : entry.partIndex}`, { ...entry, ref: entry.ref, index }]))
  return messages.map((message, messageIndex) => {
    if (!isRecord(message) || message.content === undefined) return message
    const content = message.content
    if (Array.isArray(content)) {
      let changed = false
      const next = content.map((part, partIndex) => {
        const entry = byLocation.get(`${messageIndex}:${partIndex}`)
        if (!entry) return part
        changed = true
        return { ...part, attachment: entry.ref }
      })
      return changed ? { ...message, content: next } : message
    }
    const entry = byLocation.get(`${messageIndex}:object`)
    return entry ? { ...message, content: { ...content, attachment: entry.ref } } : message
  })
}

/**
 * Build the trusted parent-side relay used to promote worker image placeholders
 * into official durable DSH attachment references.
 */
export async function createAttachmentRelay({ sourceRoot, dataRoot, storeFactory } = {}) {
  const source = requireAbsolutePath(sourceRoot, 'sourceRoot')
  const data = requireAbsolutePath(dataRoot, 'dataRoot')
  await mkdir(data, { recursive: true, mode: 0o700 })
  await chmod(data, 0o700)
  const runtime = await loadAttachmentRuntime(source)
  const context = new runtime.Context()
  let store
  let fiber
  try {
    fiber = context.plugin(async ctx => {
      const config = { dshHome: data }
      store = await (storeFactory
        ? storeFactory({ ctx, config, LocalAttachmentStore: runtime.LocalAttachmentStore, packageRoot: runtime.packageRoot })
        : new runtime.LocalAttachmentStore(ctx, config))
      return undefined
    })
    await fiber.await()
  } catch (error) {
    if (fiber) await fiber.dispose().catch(() => {})
    throw relayError('ARC_ATTACHMENT_RELAY_INIT', 'failed to construct the official local attachment store', { cause: error })
  }
  if (!store || typeof store.saveImage !== 'function' || typeof store.validateImage !== 'function') {
    await fiber.dispose().catch(() => {})
    throw relayError('ARC_ATTACHMENT_RELAY_INIT', 'attachment store does not implement validateImage/saveImage')
  }

  let closed = false
  let closePromise
  const close = async () => {
    if (!closePromise) {
      closePromise = (async () => {
        if (closed) return
        closed = true
        await fiber.dispose()
      })()
    }
    return closePromise
  }
  const restoreOptions = async options => {
    if (closed) throw relayError('ARC_ATTACHMENT_RELAY_CLOSED', 'attachment relay is closed')
    const { entries, messages } = scanOptions(options)
    if (entries.length === 0) return options
    for (const entry of entries) {
      await store.validateImage({ data: entry.image.data, mediaType: entry.image.mediaType })
    }
    for (const entry of entries) {
      entry.ref = await store.saveImage({ data: entry.image.data, mediaType: entry.image.mediaType })
    }
    return { ...options, messages: restoreMessages(messages, entries) }
  }
  return { store, restoreOptions, close }
}

export const ATTACHMENT_RELAY_LIMITS = Object.freeze({ MAX_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES })
