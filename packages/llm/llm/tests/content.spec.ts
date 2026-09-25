import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, contentHasImage, createUserMessage, OFFLOADED_IMAGE_TEXT, offloadRequestImages } from '../src/index.ts'
import type { ContentBlock } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function image(bytes: number): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

describe('contentHasImage', () => {
  it('distinguishes text, direct images, and nested tool-result images', () => {
    expect(contentHasImage([{ type: 'text', text: 'plain' }])).toBe(false)
    expect(contentHasImage([image(3)])).toBe(true)
    expect(contentHasImage([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [image(3)],
    }])).toBe(true)
  })
})

describe('offloadRequestImages', () => {
  it('preserves the original request when no provider image bound is configured', () => {
    const messages = [createUserMessage({ content: [image(3)], source })]
    expect(offloadRequestImages(messages, undefined)).toBe(messages)
  })

  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadRequestImages(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadRequestImages(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadRequestImages(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadRequestImages(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [{ type: 'text', text: OFFLOADED_IMAGE_TEXT }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadRequestImages(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OFFLOADED_IMAGE_TEXT }])
  })

  it('preserves later nested text content after the oldest image is replaced', () => {
    const later = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('text-only'),
        content: [{ type: 'text', text: 'still here' }],
      }],
      source,
    })
    const messages = [createUserMessage({ content: [image(3)], source }), later]
    const fitted = offloadRequestImages(messages, 1)
    expect(fitted[0]?.content).toEqual([{ type: 'text', text: OFFLOADED_IMAGE_TEXT }])
    expect(fitted[1]).toBe(later)
  })
})
