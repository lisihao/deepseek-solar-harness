import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { WebRunStore } from './store.js'
import { WebController } from './controller.js'
import { EgoWebAdapter } from './ego-adapter.js'
import { GrokRunStore } from './grok-store.js'
import { GrokController } from './grok-controller.js'
import { GrokEgoAdapter } from './grok-ego-adapter.js'
import { WebControl } from './control.js'
import { ModelCatalogControl } from './model-catalog-control.js'
import { createWebProvider, createWebTool } from './bindings.js'
import { WEB_LLM_PROVIDER } from './llm-adapter.js'
import { ConversationRuntime } from './conversation-runtime.js'
import { PreferencesStore, PreferencesControl, defaultWebPreferences } from './preferences.js'
import { createStudioBoundPorts } from './studio-bindings.js'
import { StudioExecutionStore } from './studio-execution-store.js'
import { installInsightPreset } from './insight-preset.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'
import type { GeminiSemanticSelectors } from './gemini-port.js'
import type { WorkflowStudioApi } from '@lisihao/dsh-solar-native-collaboration/studio-contracts'


export const name = 'chatgpt-web'
export const inject = ['tools', 'subagents', 'llm']
export interface Config {
  readonly executablePath: string
  readonly taskSpaceId: number
  readonly commandTimeoutMs: number
  readonly runTimeoutMs: number
  readonly pollMs: number
  readonly maxOutputBytes: number
  readonly modelLabel: string
  readonly effortLabel: string
  /** Empty follows the target Grok browser's current visible model. */
  readonly grokModelLabel?: string
}
export const Config: z<Config> = z.object({
  executablePath: z.string().default(join(homedir(), '.local', 'bin', 'ego-browser')),
  taskSpaceId: z.number().min(0).default(0),
  commandTimeoutMs: z.number().min(5_000).max(60_000).default(25_000),
  runTimeoutMs: z.number().min(10_000).max(7_200_000).default(1_800_000),
  pollMs: z.number().min(1_000).max(30_000).default(2_000),
  maxOutputBytes: z.number().min(1024).max(8 * 1024 * 1024).default(1024 * 1024),
  modelLabel: z.string().default(''),
  effortLabel: z.string().default(''),
  grokModelLabel: z.string().default(''),
})
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.taskSpaceId) || config.taskSpaceId < 0) throw new Error('WEB_CONFIG_INVALID: taskSpaceId 必须是非负整数。')
  if (!isAbsolute(config.executablePath)) throw new Error('WEB_CONFIG_INVALID: executablePath 必须是绝对路径。')
  const root = join(resolveDshHome(), 'solar', 'chatgpt-web')
  const controller = new WebController(new WebRunStore(root), new EgoWebAdapter({
    executable: config.executablePath, cwd: root, commandTimeoutMs: config.commandTimeoutMs,
    ...(config.taskSpaceId === 0 ? {} : { spaceId: config.taskSpaceId }),
    stdoutMaxBytes: config.maxOutputBytes + 512 * 1024,
  }), { timeoutMs: config.runTimeoutMs, pollMs: config.pollMs, stableObservations: 3, maxOutputBytes: config.maxOutputBytes })
  const grok = new GrokController(new GrokRunStore(root), new GrokEgoAdapter({
    executable: config.executablePath, cwd: root, commandTimeoutMs: config.commandTimeoutMs,
    stdoutMaxBytes: config.maxOutputBytes + 512 * 1024,
  }), { timeoutMs: config.runTimeoutMs, pollMs: config.pollMs, stableObservations: 3, maxOutputBytes: config.maxOutputBytes })
  const defaults = {
    ...(config.modelLabel.trim() ? { modelLabel: config.modelLabel.trim() } : {}),
    ...(config.effortLabel.trim() ? { effortLabel: config.effortLabel.trim() } : {}),
  }
  new WebControl(ctx, controller, defaults)
  // Discovery uses a new isolated page in the plugin's own browser, never Chrome state.
  new ModelCatalogControl(ctx, new EgoWebAdapter({
    executable: config.executablePath, cwd: root, commandTimeoutMs: config.commandTimeoutMs,
    stdoutMaxBytes: 512 * 1024,
  }), async () => (await controller.list()).some(run => ['prepared', 'ready', 'submission-unknown', 'submitted', 'indeterminate'].includes(run.stage)))
  const initial = defaultWebPreferences()
  const preferences = new PreferencesStore(root, { ...initial, web: { ...initial.web, ...defaults } })
  new PreferencesControl(ctx, preferences)
  const liveAgent = (sessionId: string) => {
    const agent = ctx.get('agents')?.get(SessionId(sessionId))
    if (!agent) throw new Error('WEB_SESSION_NOT_LIVE: 请先打开该会话，再执行需要提问或回写上下文的流程。')
    return agent
  }
  const logRequest = async (sessionId: string, text: string): Promise<void> => {
    const agent = liveAgent(sessionId)
    const sessions = ctx.get('sessions')
    if (!sessions) throw new Error('WEB_SESSION_LOG_UNAVAILABLE: 会话日志服务不可用；未调用模型。')
    agent.session.append('user/message', createUserMessage({content:[{type:'text',text}],source:{kind:'solar-web-context',form:'notice',summary:'网页与洞察流程的执行输入和用户决定'}}),{surfaceOp:'append'})
    if (!await sessions.flush(agent.session)) throw new Error('WEB_SESSION_LOG_NOT_DURABLE: 无法确认上下文已写入会话日志；未调用模型。')
  }
  const ports = createStudioBoundPorts({
    root, executable:config.executablePath, commandTimeoutMs:config.commandTimeoutMs,
    runTimeoutMs:config.runTimeoutMs, pollMs:config.pollMs,maxOutputBytes:config.maxOutputBytes,
    resident:()=>{
      const resident=ctx.get('solarNativeResident') as ResidentApi|undefined
      if(resident?.protocolVersion!==1) throw new Error('RESIDENT_UNAVAILABLE: 洞察问题澄清需要启用 Resident。')
      return resident
    }, logRequest,
    waitMsForRun:async(runId,sessionId)=>{
      const record=await new StudioExecutionStore(join(root,'studio-executions')).read(sessionId,runId)
      const config=record?.graph.parameters.config as {researchWaitMs?:number}|undefined
      return config?.researchWaitMs ?? 3_600_000
    },
    semanticsForRun:async(runId,sessionId)=>{
      const record=await new StudioExecutionStore(join(root,'studio-executions')).read(sessionId,runId)
      return record?.graph.parameters.geminiSemantics as GeminiSemanticSelectors|undefined
    },
    askQuestions:async request=>{
      const service=ctx.get('userQuestions')
      if(!service) throw new Error('WEB_QUESTIONS_UNAVAILABLE: 请启用官方用户提问功能。')
      await logRequest(request.sessionId,JSON.stringify({kind:'insight-questions',commandId:request.commandId,questions:request.questions}))
      const answer=await service.ask({agent:liveAgent(request.sessionId),signal:request.signal,questions:request.questions.map(q=>({id:q.id,question:q.text,header:'洞察分析'}))})
      const answers=answer.answers.map(a=>({questionId:a.id,text:[...a.selected,...(a.custom?[a.custom]:[])].join('；')}))
      await logRequest(request.sessionId,JSON.stringify({kind:'insight-answers',commandId:request.commandId,answers}))
      return {kind:'answered',answers}
    },
    confirmPlan:async request=>{
      const service=ctx.get('userQuestions')
      if(!service) throw new Error('WEB_QUESTIONS_UNAVAILABLE: 请启用官方用户提问功能。')
      await logRequest(request.sessionId,JSON.stringify({kind:'insight-plan-review',commandId:request.commandId,plan:request.plan}))
      const answer=await service.ask({agent:liveAgent(request.sessionId),signal:request.signal,questions:[{id:'approve-research',question:'是否按此计划开始 Gemini 深度研究？开始后可能消耗订阅额度。',detail:request.plan.text,options:[{label:'开始研究'},{label:'暂不执行'}],intent:{kind:'plan-review',approve:'开始研究'}}]})
      const confirmed=answer.answers.find(a=>a.id==='approve-research')?.selected.includes('开始研究')===true
      await logRequest(request.sessionId,JSON.stringify({kind:'insight-plan-decision',commandId:request.commandId,confirmed}))
      return confirmed ? {kind:'confirmed'} : {kind:'declined',reason:'用户未确认开始研究。'}
    },
  })
  ctx.effect(()=>()=>ports.dispose())
  const runtime=new ConversationRuntime({root,preferences,controller,ports,logRequest,pollMs:config.pollMs,grok,
    ...(config.grokModelLabel?.trim() ? {grokModelLabel:config.grokModelLabel.trim()} : {}),
    studio:()=>ctx.get('solarWorkflowStudio') as (WorkflowStudioApi & {resolveDelivery(sessionId:string,text:string):Promise<string|undefined>})|undefined,
  })
  ctx.effect(()=>ctx.llm.registerAdapter([WEB_LLM_PROVIDER],runtime))
  ctx.inject(['solarWorkflowStudio'], injected=>{
    const studio=injected.get('solarWorkflowStudio') as WorkflowStudioApi
    injected.effect(()=>studio.register(runtime.webProvider))
    injected.effect(()=>studio.register(runtime.insightProvider))
  })
  ctx.inject(['agentPresets','agents','sessions'], injected=>injected.effect(()=>installInsightPreset(injected)))

  ctx.effect(() => {
    const unregisterProvider = ctx.subagents.registerProvider(createWebProvider(controller, defaults))
    const unregisterTool = ctx.tools.register(createWebTool(controller, defaults))
    return () => { unregisterTool(); unregisterProvider() }
  })
  ctx.effect(() => () => controller.dispose())
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'solar-web-context': { kind:'solar-web-context'; form:'notice'; summary:string }
  }
}
