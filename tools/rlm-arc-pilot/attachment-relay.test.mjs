import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { ATTACHMENT_RELAY_LIMITS, createAttachmentRelay } from './attachment-relay.mjs'

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function placeholder(data = TINY_PNG, mediaType = 'image/png', overrides = {}) {
  return {
    kind: 'ipc-inline-image-v1',
    mediaType,
    dataBase64: data.toString('base64'),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
    ...overrides,
  }
}

async function withRelay(callback) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'arc-attachment-relay-'))
  const relay = await createAttachmentRelay({ sourceRoot: SOURCE_ROOT, dataRoot })
  try {
    return await callback(relay, dataRoot)
  } finally {
    await relay.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  }
}

function imageOptions(attachment, content = [{ type: 'image', attachment }]) {
  return {
    model: 'selected',
    messages: [
      { role: 'system', content: 'keep system text', source: { replayState: { cursor: 'system-opaque' } } },
      {
        role: 'user',
        content,
        source: { replayState: { cursor: 'user-opaque' } },
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'observe', arguments: '{}' } }],
      },
    ],
    tools: [{ type: 'function', function: { name: 'observe' } }],
    metadata: { keep: true },
  }
}

test('promotes inline placeholders through the published local store and preserves DSH fields', async () => {
  await withRelay(async (relay, dataRoot) => {
    const wireAttachment = placeholder()
    const options = imageOptions(wireAttachment, [
      { type: 'text', text: 'keep this text' },
      { type: 'image', attachment: wireAttachment, alt: 'keep part metadata' },
    ])
    const directImage = imageOptions(placeholder(), { type: 'image', attachment: placeholder() })
    options.messages.push(directImage.messages[1])
    const before = structuredClone(options)

    const restored = await relay.restoreOptions(options)
    assert.notStrictEqual(restored, options)
    assert.deepEqual(options, before)
    assert.equal(restored.messages[0].source.replayState.cursor, 'system-opaque')
    assert.equal(restored.messages[1].source.replayState.cursor, 'user-opaque')
    assert.deepEqual(restored.messages[1].tool_calls, options.messages[1].tool_calls)
    assert.deepEqual(restored.tools, options.tools)
    assert.equal(restored.metadata.keep, true)
    assert.equal(restored.messages[1].content[0].text, 'keep this text')

    const ref = restored.messages[1].content[1].attachment
    assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/)
    assert.equal(ref.width, 1)
    assert.equal(ref.height, 1)
    assert.ok(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mediaType))
    const stored = await relay.store.readImage(ref)
    assert.deepEqual(stored.ref, ref)
    assert.equal(stored.data.byteLength, ref.bytes)

    const directRef = restored.messages[2].content.attachment
    assert.equal(directRef.attachmentId, ref.attachmentId)
    await relay.close()
    await access(join(dataRoot, 'attachments', 'v1'))
    const rootStat = await stat(dataRoot)
    assert.equal(rootStat.isDirectory(), true)
    await assert.rejects(relay.restoreOptions(options), error => error?.code === 'ARC_ATTACHMENT_RELAY_CLOSED')
  })
})

test('rejects malformed, remote, unsupported, or oversized wire attachments', async () => {
  await withRelay(async relay => {
    const cases = [
      ['bad SHA-256', placeholder(TINY_PNG, 'image/png', { sha256: '0'.repeat(64) }), 'ARC_ATTACHMENT_HASH'],
      ['wrong byte count', placeholder(TINY_PNG, 'image/png', { bytes: TINY_PNG.byteLength + 1 }), 'ARC_ATTACHMENT_BYTES'],
      ['non-canonical base64', placeholder(TINY_PNG, 'image/png', { dataBase64: 'not-base64!' }), 'ARC_ATTACHMENT_BASE64'],
      ['unknown attachment shape', { attachmentId: 'https://example.invalid/image.png' }, 'ARC_ATTACHMENT_SHAPE'],
      ['unsupported media type', placeholder(TINY_PNG, 'image/tiff'), 'ARC_ATTACHMENT_MEDIA_TYPE'],
      ['single image size limit', placeholder(TINY_PNG, 'image/png', { bytes: ATTACHMENT_RELAY_LIMITS.MAX_IMAGE_BYTES + 1 }), 'ARC_ATTACHMENT_SIZE'],
    ]
    for (const [name, attachment, code] of cases) {
      await assert.rejects(
        relay.restoreOptions(imageOptions(attachment)),
        error => error?.code === code,
        name,
      )
    }
    await assert.rejects(
      relay.restoreOptions({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] }] }),
      error => error?.code === 'ARC_ATTACHMENT_REMOTE_URL',
    )
    await assert.rejects(
      relay.restoreOptions(imageOptions({ kind: 'ipc-inline-image-v1', mediaType: 'image/png', dataBase64: TINY_PNG.toString('base64'), sha256: createHash('sha256').update(TINY_PNG).digest('hex'), bytes: TINY_PNG.byteLength, extra: true })),
      error => error?.code === 'ARC_ATTACHMENT_SHAPE',
    )
    const malformed = Buffer.from('not-an-image')
    await assert.rejects(
      relay.restoreOptions(imageOptions(placeholder(malformed))),
      error => error?.code === 'INVALID_IMAGE',
    )
    await assert.rejects(
      relay.restoreOptions(imageOptions(placeholder(TINY_PNG, 'image/jpeg'))),
      error => error?.code === 'IMAGE_TYPE_MISMATCH',
    )
  })
})

test('enforces the aggregate request image limit before calling the native store', async () => {
  await withRelay(async relay => {
    const sevenMiB = Buffer.alloc(7 * 1024 * 1024, 0x5a)
    const attachments = Array.from({ length: 5 }, () => placeholder(sevenMiB))
    await assert.rejects(
      relay.restoreOptions({ messages: [{ role: 'user', content: attachments.map(attachment => ({ type: 'image', attachment })) }] }),
      error => error?.code === 'ARC_ATTACHMENT_TOTAL_SIZE',
    )
  })
})
