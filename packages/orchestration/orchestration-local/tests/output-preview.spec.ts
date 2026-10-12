/** The result preview a node event carries. */

import { describe, expect, it } from 'vitest'
import { MAX_OPERATOR_OUTPUT_PREVIEW, operatorOutputPreview } from '../src/output-preview.ts'

describe('operatorOutputPreview', () => {
  it('leaves the operator\'s reasoning out of the result and keeps its answer first', () => {
    expect(operatorOutputPreview([
      { type: 'reasoning', text: 'Drafting concise Chinese suggestion' },
      { type: 'text', text: '结论：通过' },
      { type: 'text', text: '没有发现问题。' },
    ])).toEqual({ outputPreview: '结论：通过\n没有发现问题。', outputTruncated: false })
  })

  it('writes other visible blocks as JSON and gives an output of only reasoning an empty preview', () => {
    const image = { type: 'image', url: 'file:///a.png' } as never
    expect(operatorOutputPreview([{ type: 'text', text: 'a' }, image]).outputPreview).toBe(`a\n${JSON.stringify(image)}`)
    expect(operatorOutputPreview([{ type: 'reasoning', text: 'thinking' }])).toEqual({ outputPreview: '', outputTruncated: false })
    expect(operatorOutputPreview([])).toEqual({ outputPreview: '', outputTruncated: false })
  })

  it('cuts the preview at the bound and says so, counting only what it keeps', () => {
    const exact = 'x'.repeat(MAX_OPERATOR_OUTPUT_PREVIEW)
    expect(operatorOutputPreview([{ type: 'reasoning', text: 'y'.repeat(MAX_OPERATOR_OUTPUT_PREVIEW) }, { type: 'text', text: exact }]))
      .toEqual({ outputPreview: exact, outputTruncated: false })
    const over = operatorOutputPreview([{ type: 'text', text: `${exact}z` }])
    expect(over.outputPreview).toBe(exact)
    expect(over.outputTruncated).toBe(true)
  })
})
