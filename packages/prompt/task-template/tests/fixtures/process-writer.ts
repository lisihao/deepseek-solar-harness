#!/usr/bin/env node
/** Write one template update from a separate process through the real file-backed Provider. */

import { Context } from '@deepseek-ai/cordis'
import { taskTemplateId } from '../../src/brand.ts'
import FileTaskTemplateProvider from '../../src/local.ts'

const [dshHome, rawId, method] = process.argv.slice(2)
if (dshHome === undefined || rawId === undefined || method === undefined) {
  throw new Error('process-writer requires <dsh-home> <template-id> <method>')
}

const ctx = new Context()
try {
  await ctx.plugin(FileTaskTemplateProvider, { dshHome, watch: false })
  const template = await ctx.taskTemplates.update(taskTemplateId(rawId), { method })
  process.stdout.write(`${JSON.stringify({ pid: process.pid, version: template.version })}\n`)
} finally {
  await ctx.fiber.dispose()
}
