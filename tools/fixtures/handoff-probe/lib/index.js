import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['appReady', 'agents', 'commands', 'llm', 'userQuestions', 'sessionQuery']
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const checks = {}
      let error
      try {
        const calls = []
        const draft = JSON.stringify({ summary: '已核实的任务摘要', questions: [{ id: 'q1', question: '下一步优先什么？', options: ['先跑离线测试', '先复核已有记录'] }, { id: 'q2', question: '还有什么限制？', options: ['不要发布', '沿用已确认限制'] }] })
        class FixtureAdapter extends LlmAdapter {
          async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } } }
          async *stream(options) {
            calls.push(options)
            yield { type: 'text-delta', index: 0, text: options.model === 'gpt-6-luna' ? draft : 'fixture response' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
        const registration = ctx.llm.registerAdapter(['fixture-old', 'fixture-target', 'openai-codex'], new FixtureAdapter())
        const selection = { current: { provider: 'fixture-old', model: 'old' }, assembled: undefined }
        const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: process.env.DSH_HOME }, agentOptions: selection.current,
          setup: agentCtx => { installModelSelection(agentCtx, selection) } })
        const agent = handle.agent
        checks.command = ctx.commands.list(agent).some(command => command.name === 'handoff')
        if (!checks.command) throw new Error('Handoff command did not activate under the real Loader.')
        const result = await ctx.commands.execute(agent, '/handoff status', [], new AbortController().signal)
        checks.status = result?.result.kind === 'success' && result.result.text.includes('尚无模型交接记录')
        if (!checks.status) throw new Error('Built plugin status command failed.')
        checks.isolation = ctx.get('compaction')?.constructor.name !== 'HandoffEngine'
        if (!checks.isolation) throw new Error('Handoff replaced the original compaction service.')
        let questionStarted
        const questionSeen = new Promise(resolve => { questionStarted = resolve })
        let release
        const answerReady = new Promise(resolve => { release = resolve })
        const disposeAnswerer = ctx.on('user-questions/request', async (request, next) => {
          if (request.agent?.id !== agent.id) return next()
          if (request.questions[0]?.id === 'handoff-confirm') return { answers: [{ id: 'handoff-confirm', selected: ['确认并继续'] }] }
          checks.contextualChoices = (checks.contextualChoices ?? true) && request.questions.every(question => question.options?.some(option => option.label === (question.id === 'q1' ? '先跑离线测试' : '不要发布')))
          checks.oneQuestionPerCard = (checks.oneQuestionPerCard ?? true) && request.questions.length === 1
          if (!checks.contextualChoices || !checks.oneQuestionPerCard) throw new Error('Built plugin did not expose contextual answer choices.')
          questionStarted()
          await answerReady
          return { answers: request.questions.map(question => ({ id: question.id, selected: question.id === 'q1' ? ['先跑离线测试'] : [], ...(question.id === 'q2' ? { custom: '不要发布' } : {}) })) }
        })
        const oldBulk = 'ORIGINAL_HISTORY_MUST_NOT_REACH_TARGET_'.repeat(180)
        agent.followup(createUserMessage({ content: [{ type: 'text', text: oldBulk }], source: { kind: 'user' } }))
        await agent.whenIdle()
        if (!calls.some(call => call.model === 'old')) throw new Error('Original real AgentLoop did not call the fake adapter.')
        selection.current = { provider: 'fixture-target', model: 'target' }
        agent.session.append('model/selection', selection.current)
        await questionSeen
        agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续执行离线检查' }], source: { kind: 'user' } }))
        await new Promise(resolve => setImmediate(resolve))
        checks.waitsForHuman = !calls.some(call => call.model === 'target')
        if (!checks.waitsForHuman) throw new Error('Target adapter ran before human confirmation.')
        release()
        await agent.whenIdle()
        const targetCall = calls.find(call => call.model === 'target')
        const targetText = JSON.stringify(targetCall?.messages)
        checks.condensedRequest = Boolean(targetCall) && targetText.includes('已核实的任务摘要') && targetText.includes('先跑离线测试') && targetText.includes('不要发布') && targetText.includes('继续执行离线检查') && !targetText.includes(oldBulk)
        const raw = await ctx.sessionQuery.readSession(agent.session.id)
        checks.rawHistory = JSON.stringify(raw.events).includes(oldBulk)
        const summary = raw.events.find(event => event.type === 'compaction/summary')
        checks.trace = Boolean(summary) && summary.data.llmStreamCall !== true && JSON.stringify(summary.data.rawOutput).includes(oldBulk)
        if (!checks.condensedRequest || !checks.rawHistory || !checks.trace) throw new Error('Real AgentLoop handoff lost source, answers, or request isolation.')
        disposeAnswerer()
        await handle.dispose()
        registration()
      } catch (caught) { error = caught instanceof Error ? caught.stack : String(caught) }
      await writeFile(process.env.SOLAR_HANDOFF_MARKER, JSON.stringify({ ok: error === undefined, checks, error }))
      ctx.get('appExit')(error === undefined ? 0 : 1)
    })()
  }))
}
