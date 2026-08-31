// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadBlock } from '../src/ReadBlock.tsx'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  readonly unobserved = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void {
    this.observed.delete(element)
    this.unobserved.add(element)
  }
  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  intersect(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('viewport-activated syntax highlighting', () => {
  it('keeps offscreen blocks plain and permanently activates intersecting blocks', async () => {
    const view = render(
      <>
        <CodeBlock code="const first = 1" lang="ts" />
        <CodeBlock code="const second = 2" lang="ts" />
      </>,
    )
    const blocks = [...view.container.querySelectorAll('.md-code-block')]
    const observer = IntersectionObserverStub.instances[0]!
    expect(observer.observed.size).toBe(2)
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => { observer.intersect(blocks[0]!, true) })
    await waitFor(() => { expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull() })
    expect(blocks[1]!.querySelector('pre.shiki')).toBeNull()
    expect(observer.unobserved.has(blocks[0]!)).toBe(true)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()
  })

  it('does not observe unsupported languages and releases the shared observer on unmount', () => {
    const unsupported = render(<CodeBlock code="IDENTIFICATION DIVISION." lang="cobol" />)
    expect(IntersectionObserverStub.instances).toHaveLength(0)
    unsupported.unmount()

    const pending = render(<CodeBlock code="const pending = true" lang="ts" />)
    const block = pending.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!
    pending.unmount()
    expect(observer.unobserved.has(block)).toBe(true)
    expect(observer.disconnected).toBe(true)
  })

  it('highlights immediately without IntersectionObserver and gates read cards otherwise', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const fallback = render(<CodeBlock code="const fallback = true" lang="ts" />)
    expect(fallback.container.querySelector('pre.shiki')).not.toBeNull()
    fallback.unmount()

    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const read = render(
      <ReadBlock label="data.json" lang="json" lines={[{ number: 1, text: '{"ready":true}' }]} totalLines={1} />,
    )
    const block = read.container.querySelector('[data-read]')!
    expect(block.querySelectorAll('[style]').length).toBe(0)
    const observer = IntersectionObserverStub.instances.at(-1)!
    act(() => { observer.intersect(block, true) })
    await waitFor(() => { expect(block.querySelectorAll('[style]').length).toBeGreaterThan(0) })
  })
})
