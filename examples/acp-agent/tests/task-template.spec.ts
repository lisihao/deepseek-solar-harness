import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import * as TaskTemplate from '@deepseek-ai/dsh-task-template'
import * as TaskTemplateContext from '@deepseek-ai/dsh-task-template-context'
import * as taskTemplateFixtureSeed from './fixtures/task-template/seed.ts'
import { FIXTURE_TEMPLATE_ID } from './fixtures/task-template/seed.ts'

const cleanups: Array<() => Promise<void>> = []
const TASK_TEMPLATE_FIXTURE = new URL('./fixtures/task-template/', import.meta.url)
const LOADER_CONFIG = fileURLToPath(new URL('cordis.yml', TASK_TEMPLATE_FIXTURE))
const LOADER_DRIVER = fileURLToPath(new URL('driver.ts', TASK_TEMPLATE_FIXTURE))
const ROOT_TSCONFIG = fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function scratchDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-task-template-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('ACP example: task-template composition', () => {
  it('boots a real Loader tree and admits the seeded template through AgentLoop', async () => {
    const result = await runLoaderSmoke({
      label: 'ACP task-template Loader composition',
      tempDirPrefix: 'dsh-acp-task-template-loader-',
      binScript: LOADER_DRIVER,
      libBinScript: LOADER_DRIVER,
      configPath: LOADER_CONFIG,
      tsconfigPath: ROOT_TSCONFIG,
    })

    expect(JSON.parse(result.stdout)).toEqual({
      decisions: 1,
      injectedMessages: 1,
      reply: 'fixture playbook complete',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('boots the real Loader-unwrapped exports and injects the seeded template through a concrete AgentLoop request', async () => {
    const dshHome = await scratchDshHome()
    const loader = Object.create(Loader.prototype) as Loader

    const providerExports = loader.unwrapExports(TaskTemplate) as Parameters<Context['plugin']>[0]
    const contextExports = loader.unwrapExports(TaskTemplateContext) as Parameters<Context['plugin']>[0]
    const seedExports = loader.unwrapExports(taskTemplateFixtureSeed) as Parameters<Context['plugin']>[0]
    expect((TaskTemplateContext as Record<string, unknown>)['name']).toBe('task-template-context')
    expect('default' in TaskTemplateContext).toBe(false)

    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(providerExports, { dshHome, watch: false })
    await ctx.plugin(seedExports)
    await ctx.plugin(contextExports)
    const adapter = new ScriptedAdapter([textResponse('fixture playbook complete')])
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))

    const agent = ctx.agentLoop.create(SessionId('acp-task-template-fixture'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run the fixture playbook end to end.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).toContain('dshTaskPromptTemplate')
    expect(requestText(adapter.requests[0]!)).toContain(FIXTURE_TEMPLATE_ID)
    const injected = agent.session.events.find(
      event => event.type === 'user/message' && event.data.source.kind === 'task-template',
    )
    expect(injected).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('persists the seeded template to the real file-backed store so a second process boot observes it', async () => {
    const dshHome = await scratchDshHome()
    const loader = Object.create(Loader.prototype) as Loader
    const providerExports = loader.unwrapExports(TaskTemplate) as Parameters<Context['plugin']>[0]
    const seedExports = loader.unwrapExports(taskTemplateFixtureSeed) as Parameters<Context['plugin']>[0]

    const first = new Context()
    await first.plugin(providerExports, { dshHome, watch: false })
    await first.plugin(seedExports)
    await first.fiber.dispose()

    const second = new Context()
    await second.plugin(providerExports, { dshHome, watch: false })
    expect(second.taskTemplates.get(FIXTURE_TEMPLATE_ID)?.name).toBe('ACP fixture playbook')
    await second.fiber.dispose()
  })
})
