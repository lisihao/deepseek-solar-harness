import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { selectTaskTemplate, taskTemplateId } from '@deepseek-ai/dsh-task-template'
import type { TaskAttributes, TaskTemplate, TaskTemplateInjectionReceipt } from '@deepseek-ai/dsh-task-template'
import * as TaskTemplateContextInvariant from '../src/invariant.ts'
import { renderTaskTemplateReceipt } from '../src/index.ts'

const ATTRIBUTES: TaskAttributes = {
  taskType: 'review',
  domain: 'frontend',
  objective: 'Review the fictional UI.',
  outputFormat: 'answer',
  riskLevel: 'low',
  tools: [],
  skills: [],
  operators: [],
  language: 'en',
  priority: 'normal',
}

const TEMPLATE: TaskTemplate = {
  id: taskTemplateId('fixture-review'),
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  name: 'Fixture review',
  rank: 0,
  match: {},
  method: 'Review {{objective}}',
  updatedAt: '2026-01-01T00:00:00.000Z',
  history: [],
}

const SELECTION = selectTaskTemplate([TEMPLATE], new Map(), { attributes: ATTRIBUTES })
const SKIP = selectTaskTemplate([], new Map(), { attributes: ATTRIBUTES })
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(TaskTemplateContextInvariant)
  return ctx
}

function selectedMessage(text = renderTaskTemplateReceipt(SELECTION.receipt)) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'task-template', form: 'instructions', receipt: SELECTION.receipt },
  })
}

function invariantError(): Partial<InvariantError> {
  return { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-task-template-context' }
}

describe('task-template context invariant', () => {
  it('accepts one initial decision/message pair and one exact restore in the same turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('task-template-invariant-valid'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
      session.append('user/message', selectedMessage(), { surfaceOp: 'append' })
      session.append('task-template/decided', {
        turn: 1,
        receipt: SELECTION.receipt,
        restored: true,
      }, { ignorable: true })
      session.append('user/message', selectedMessage(), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('accepts an attributable skip and the direct-fixture implicit turn', async () => {
    const ctx = await setup()
    const skipped = ctx.sessions.create(SessionId('task-template-invariant-skip'))
    expect(() => {
      skipped.append('turn/start', { turn: 1 })
      skipped.append('task-template/decided', { turn: 1, receipt: SKIP.receipt }, { ignorable: true })
      skipped.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()

    const implicit = ctx.sessions.create(SessionId('task-template-invariant-implicit'))
    expect(() => {
      implicit.append('task-template/decided', { turn: 0, receipt: SELECTION.receipt }, { ignorable: true })
      implicit.append('user/message', selectedMessage(), { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects unattributed and payload-tampered task-template messages before commit', async () => {
    const ctx = await setup()
    const unattributed = ctx.sessions.create(SessionId('task-template-invariant-unattributed'))
    unattributed.append('turn/start', { turn: 1 })
    expect(() => {
      unattributed.append('user/message', selectedMessage(), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining(invariantError()))

    const tampered = ctx.sessions.create(SessionId('task-template-invariant-tampered'))
    tampered.append('turn/start', { turn: 1 })
    tampered.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
    expect(() => {
      tampered.append('user/message', selectedMessage('tampered'), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('rejects a duplicate initial decision and a restore with a different receipt', async () => {
    const ctx = await setup()
    const duplicate = ctx.sessions.create(SessionId('task-template-invariant-duplicate'))
    duplicate.append('turn/start', { turn: 1 })
    duplicate.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
    expect(() => {
      duplicate.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))

    const restore = ctx.sessions.create(SessionId('task-template-invariant-restore'))
    restore.append('turn/start', { turn: 1 })
    restore.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
    const changed = { ...SELECTION.receipt, templateName: 'Tampered name' }
    expect(() => {
      restore.append('task-template/decided', { turn: 1, receipt: changed, restored: true }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('rejects a receipt whose rendered-content hash was altered', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('task-template-invariant-hash'))
    session.append('turn/start', { turn: 1 })
    const changed = { ...SELECTION.receipt, contentSha256: '0'.repeat(64) }
    expect(() => {
      session.append('task-template/decided', { turn: 1, receipt: changed }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('rejects malformed decision placement and metadata', async () => {
    const ctx = await setup()
    const outside = ctx.sessions.create(SessionId('task-template-invariant-outside'))
    expect(() => {
      outside.append('task-template/decided', { turn: 1, receipt: SKIP.receipt }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))

    const wrongTurn = ctx.sessions.create(SessionId('task-template-invariant-wrong-turn'))
    wrongTurn.append('turn/start', { turn: 1 })
    expect(() => {
      wrongTurn.append('task-template/decided', { turn: 2, receipt: SKIP.receipt }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))

    const required = ctx.sessions.create(SessionId('task-template-invariant-required'))
    required.append('turn/start', { turn: 1 })
    expect(() => {
      required.append('task-template/decided', { turn: 1, receipt: SKIP.receipt })
    }).toThrow(expect.objectContaining(invariantError()))

    const firstRestore = ctx.sessions.create(SessionId('task-template-invariant-first-restore'))
    firstRestore.append('turn/start', { turn: 1 })
    expect(() => {
      firstRestore.append('task-template/decided', {
        turn: 1,
        receipt: SELECTION.receipt,
        restored: true,
      }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('rejects an incomplete receipt and a sourced message outside a turn', async () => {
    const ctx = await setup()
    const { renderedContent: _omitted, ...fields } = SELECTION.receipt
    const incomplete = fields as TaskTemplateInjectionReceipt
    const receipt = ctx.sessions.create(SessionId('task-template-invariant-incomplete'))
    receipt.append('turn/start', { turn: 1 })
    expect(() => {
      receipt.append('task-template/decided', { turn: 1, receipt: incomplete }, { ignorable: true })
    }).toThrow(expect.objectContaining(invariantError()))

    const message = ctx.sessions.create(SessionId('task-template-invariant-message-outside'))
    expect(() => {
      message.append('user/message', selectedMessage(), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('validates sessions that predate companion registration', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('task-template-invariant-seeded'))
    session.append('turn/start', { turn: 1 })
    session.append('task-template/decided', { turn: 1, receipt: SELECTION.receipt }, { ignorable: true })
    session.append('user/message', selectedMessage(), { surfaceOp: 'append' })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TaskTemplateContextInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
