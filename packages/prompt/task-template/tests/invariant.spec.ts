import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as TaskTemplateInvariant from '../src/invariant.ts'
import { taskTemplateId } from '../src/brand.ts'
import { MemoryTaskTemplates } from './memory.ts'

const cleanups: Array<() => Promise<void>> = []
const TEMPLATE_ID = taskTemplateId('fixture-invariant')

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function setup(withProvider: boolean): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  if (withProvider) await ctx.plugin(MemoryTaskTemplates)
  await ctx.plugin(TaskTemplateInvariant)
  return ctx
}

function invariantError(): Partial<InvariantError> {
  return { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-task-template' }
}

describe('task-template store invariant', () => {
  it('accepts lifecycle events emitted from the committed service state', async () => {
    const ctx = await setup(true)
    await expect(ctx.taskTemplates.create({
      id: TEMPLATE_ID,
      name: 'Fixture invariant',
      method: 'Fictional method.',
    })).resolves.toMatchObject({ version: 1 })
    await expect(ctx.taskTemplates.delete(TEMPLATE_ID)).resolves.toBeUndefined()
  })

  it('rejects an update event without a live service', async () => {
    const ctx = await setup(false)
    expect(() => {
      ctx.emit('task-template/updated', TEMPLATE_ID, 'update', 1)
    }).toThrow(expect.objectContaining(invariantError()))
  })

  it('rejects delete, missing-template, and version claims that disagree with committed state', async () => {
    const ctx = await setup(true)
    await ctx.taskTemplates.create({ id: TEMPLATE_ID, name: 'Fixture invariant', method: 'Fictional method.' })
    expect(() => {
      ctx.emit('task-template/updated', TEMPLATE_ID, 'delete', 1)
    }).toThrow(expect.objectContaining(invariantError()))
    expect(() => {
      ctx.emit('task-template/updated', taskTemplateId('fixture-missing'), 'update', 1)
    }).toThrow(expect.objectContaining(invariantError()))
    expect(() => {
      ctx.emit('task-template/updated', TEMPLATE_ID, 'update', 2)
    }).toThrow(expect.objectContaining(invariantError()))
  })
})
