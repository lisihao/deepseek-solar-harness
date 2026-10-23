import { afterEach, describe, expect, it } from 'vitest'

import { __selftestInternals, startFakeOpenAiProvider, type FakeOpenAiProvider } from '../src/selftest.js'

const providers: FakeOpenAiProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()))
})

describe('Prime local keyless self-test fixture', () => {
  it('routes the original refinement system prompt to a schema-valid local edit', () => {
    const reply = __selftestInternals.chooseFakeReply({
      messages: [{
        role: 'system',
        content: "You are Prime Agent's /refine continual harness subsystem.",
      }],
    }, {
      receipt: '/tmp/receipt.json',
      grandchildReceipt: '/tmp/grandchild.json',
      childReceipt: '/tmp/child.json',
    }, 10_000)

    expect(reply.kind).toBe('text')
    if (reply.kind !== 'text') throw new Error('expected a refinement text reply')
    const proposal = JSON.parse(reply.text) as Record<string, unknown>
    expect(proposal.summary).toBeTypeOf('string')
    expect(proposal.rationale).toBeTypeOf('string')
    expect(proposal.expectedOutcome).toBeTypeOf('string')
    expect(proposal.edits).toEqual([expect.objectContaining({
      action: 'create',
      kind: 'memory',
      id: 'selftest-refine-memory',
    })])
  })

  it('defers native collect calls until the original child-exited continuation', () => {
    const paths = {
      receipt: '/tmp/receipt.json',
      grandchildReceipt: '/tmp/grandchild.json',
      childReceipt: '/tmp/child.json',
    }
    const rootWait = __selftestInternals.chooseFakeReply({
      messages: [{ role: 'user', content: 'SELFTEST_ROOT: fixture route only' }],
    }, paths, 10_000, 4)
    expect(rootWait).toMatchObject({ kind: 'text', label: 'root-await-child' })

    const rootCollect = __selftestInternals.chooseFakeReply({
      messages: [{ role: 'user', content: '[child-exited: no-reply child:selftest-child]\n\nChild completed.' }],
    }, paths, 10_000)
    expect(rootCollect).toMatchObject({ kind: 'tool', label: 'root-collect' })
    if (rootCollect.kind === 'tool') expect(rootCollect.code).toContain('rlm.collect(root_child')

    const childCollect = __selftestInternals.chooseFakeReply({
      messages: [{ role: 'user', content: '[child-exited: no-reply child:selftest-grandchild]\n\nGrandchild completed.' }],
    }, paths, 10_000)
    expect(childCollect).toMatchObject({ kind: 'tool', label: 'child-collect' })
    if (childCollect.kind === 'tool') expect(childCollect.code).toContain('rlm.collect(grandchild')
  })

  it('uses a loopback-only OpenAI compatible endpoint and closes it idempotently', async () => {
    const provider = await startFakeOpenAiProvider({
      receipt: '/tmp/receipt.json',
      grandchildReceipt: '/tmp/grandchild.json',
      childReceipt: '/tmp/child.json',
    })
    providers.push(provider)
    expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'loopback-v1',
        messages: [{ role: 'user', content: 'SELFTEST_ROOT: fixture route only' }],
        tools: [{ type: 'function', function: { name: 'python_repl' } }],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('python_repl')
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]).toMatchObject({ label: 'root-cell-a', model: 'loopback-v1' })

    await provider.close()
    await provider.close()
    expect(provider.listening()).toBe(false)
  })
})
