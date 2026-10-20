import { createHash } from 'node:crypto'
import {
  LlmAdapter, LlmError, type GenerateOptions, type PreparedAdapterCall,
  type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { StudioGraph, StudioProvider, StudioRun, StudioSource, WorkflowStudioApi } from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import { WebLlmAdapter, WEB_LLM_PROVIDER, type WebLlmRequestCapture } from './llm-adapter.js'
import { ConversationWebAdapter, type InsightStartInput } from './conversation-adapter.js'
import { PreferencesStore, type WebPreferences } from './preferences.js'
import { buildInsightStudioGraph, buildWebStudioGraph, createInsightStudioProvider, createWebStudioProvider, type StudioBoundPorts } from './studio-provider.js'
import { versionedTemplate } from './insight-contract.js'
import { flowReadiness } from './flow-readiness.js'
import { WebRunStore, type WebRunRecord } from './store.js'
import type { WebController } from './controller.js'

export function workflowUuid(value: string): string {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

export interface ConversationRuntimeOptions {
  root: string
  preferences: PreferencesStore
  controller: Pick<WebController, 'start' | 'observe'>
  studio: () => (WorkflowStudioApi & { resolveDelivery(sessionId:string,text:string):Promise<string|undefined> }) | undefined
  ports: StudioBoundPorts
  logRequest(sessionId:string,text:string):Promise<void>
  pollMs:number
}

export function webRecordToStudio(record: WebRunRecord, sessionId: string): StudioRun {
  const status = record.stage === 'completed' ? 'completed'
    : record.stage === 'blocked' || record.stage === 'failed' ? 'failed'
      : record.stage === 'cancelled' ? 'cancelled'
        : record.stage === 'indeterminate' || record.stage === 'submission-unknown' ? 'unknown' : 'running'
  return {
    id: record.id, sessionId, providerId: 'web', status,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    nodes: [{ nodeId: 'chatgpt-web', status,
      ...(record.output ? { output: record.output.markdown } : {}),
      ...(record.error ? { error: record.error.message } : {}),
      ...(record.observed ? { observed: { ...record.observed } } : {}),
    }],
    ...(record.output ? { output: record.output.markdown } : {}),
    ...(record.error ? { message: record.error.message } : {}),
  }
}

/** Public routes and source capture. A prepared call retains one settings snapshot. */
export class ConversationRuntime extends LlmAdapter {
  readonly webProvider: StudioProvider
  readonly insightProvider: StudioProvider
  private readonly insight
  private readonly web
  private readonly automaticDelivery = new Set<string>()
  private readonly captures = new Map<string, { sessionId:string; graph:StudioGraph }>()
  constructor(private readonly options: ConversationRuntimeOptions) {
    super()
    this.web = createWebStudioProvider({ root:options.root, ports:options.ports })
    this.insight = createInsightStudioProvider({ root:options.root, ports:options.ports })
    this.webProvider = { ...this.web, id:this.web.id, label:'ChatGPT 网页流程',
      assertCanResume:(s,id)=>this.assertDeliveryReleased(s,id),
      validate:graph=>this.web.validate(graph), execute:request=>this.web.execute(request), inspect:(s,id)=>this.web.inspect(s,id),resume:async(s,id)=>{
        const original=await new WebRunStore(options.root).read(id)
        return original ? webRecordToStudio(await options.controller.observe(id),s) : this.web.resume(s,id)
      },
      observeSource: async source => {
        if (source.runId === undefined) throw new Error('WEB_SOURCE_RUN_MISSING: 网页流程缺少原运行记录。')
        const record = await new WebRunStore(options.root).read(source.runId)
        if (record) return this.captureWeb(await options.controller.observe(source.runId), source.graph.sessionId, source.graph)
        return this.web.inspect(source.graph.sessionId,source.runId)
      },
    }
    this.insightProvider = { id:this.insight.id, label:'洞察分析流程',
      assertCanResume:(s,id)=>this.assertDeliveryReleased(s,id),
      validate:async graph=>[...await this.insight.validate(graph),...flowReadiness(graph)], execute:async request=>{
        const issues=flowReadiness(request.graph)
        if(issues.length)throw new LlmError(issues.map(i=>i.message).join(' '),'INSIGHT_NOT_CONFIGURED')
        return this.insight.execute(request)
      }, inspect:(s,id)=>this.insight.inspect(s,id),resume:(s,id)=>this.insight.resume(s,id),
      observeSource: async source => {
        if (!source.runId) throw new Error('INSIGHT_SOURCE_RUN_MISSING: 洞察流程缺少原运行记录。')
        const run=await this.insight.inspect(source.graph.sessionId,source.runId)
        await this.capture(source,run)
        return run
      },
    }
  }
  private async assertDeliveryReleased(sessionId:string,id:string):Promise<void> {
    if(this.automaticDelivery.has(`${sessionId}:${id}`))throw new Error('STUDIO_CONVERSATION_ACTIVE: 原会话仍在等待本次结果，请等待当前请求结束后再继续原执行。')
  }
  private async capture(source:Pick<StudioSource,'id'|'graph'|'runId'>,run?:StudioRun):Promise<void> {
    await this.options.studio()?.capture({ ...source, ...(run===undefined?{}:{run}) })
  }
  private async captureWeb(record:WebRunRecord,sessionId:string,graph:StudioGraph):Promise<StudioRun> {
    const run=webRecordToStudio(record,sessionId)
    await this.capture({id:record.id,graph,runId:record.id},run)
    return run
  }
  private pendingRun(id:string,graph:StudioGraph):StudioRun {
    const time=new Date().toISOString()
    return {id,sessionId:graph.sessionId,providerId:graph.providerId,status:'pending',nodes:graph.nodes.map(node=>({nodeId:node.id,status:'pending' as const})),createdAt:time,updatedAt:time}
  }
  private async unknownSource(id:string,sessionId:string,graph:StudioGraph,error:unknown):Promise<void> {
    const pending=this.pendingRun(id,graph)
    await this.capture({id,graph,runId:id},{...pending,status:'unknown',message:`原执行结果待核对；未重新提交。${error instanceof Error?error.message:String(error)}`})
  }
  private async onWebRequest(input:WebLlmRequestCapture):Promise<void> {
    const graph=buildWebStudioGraph({sessionId:input.sessionId,context:'',question:input.request.prompt,config:{
      requested:{provider:'chatgpt',modelLabel:input.request.modelLabel ?? '',...(input.request.effortLabel?{effortLabel:input.request.effortLabel}:{})},
      template:versionedTemplate('web-conversation','1',input.request.prompt),title:'ChatGPT 网页回答',parameters:{inputForm:'complete-request'},
    }})
    await this.options.logRequest(input.sessionId,JSON.stringify({kind:'web-request',id:input.id,request:input.request}))
    await this.capture({id:input.id,graph,runId:input.id},this.pendingRun(input.id,graph))
    this.captures.set(input.id,{sessionId:input.sessionId,graph})
    this.automaticDelivery.add(`${input.sessionId}:${input.id}`)
  }
  private generation(preferences:WebPreferences):ConversationWebAdapter {
    const wrapped={
      start: async (...args:Parameters<WebController['start']>) => {
        const source=this.captures.get(args[0])
        try {
          const record=await this.options.controller.start(...args)
          if(source) await this.captureWeb(record,source.sessionId,source.graph)
          return record
        } catch(error) {
          if(source) await this.unknownSource(args[0],source.sessionId,source.graph,error)
          throw error
        } finally {
          if(source)this.automaticDelivery.delete(`${source.sessionId}:${args[0]}`)
        }
      },
      observe: async (...args:Parameters<WebController['observe']>) => {
        const record=await this.options.controller.observe(...args)
        const source=this.captures.get(record.id)
        if(source) await this.captureWeb(record,source.sessionId,source.graph)
        return record
      },
    }
    return new ConversationWebAdapter({
      web:new WebLlmAdapter(wrapped,{...preferences.web,onRequest:input=>this.onWebRequest(input)}),
      startInsight:input=>this.startInsight(input,preferences),
      inspectInsight:async(sessionId,id)=>{
        const record=await this.insight.store.read(sessionId,id)
        if(!record) throw new Error('INSIGHT_RUN_MISSING: 洞察流程尚未取得运行回执。')
        const run=await this.insight.inspect(sessionId,id)
        await this.capture({id,graph:record.graph,runId:id},run)
        return run
      },
      resolveDelivery:(sessionId,text)=>this.options.studio()?.resolveDelivery(sessionId,text) ?? Promise.resolve(undefined),
      insightWaitMs:preferences.insight.researchWaitMs,pollMs:this.options.pollMs,
    })
  }
  private async startInsight(input:InsightStartInput,preferences:WebPreferences):Promise<StudioRun> {
    const prior=await this.insight.store.read(input.sessionId,input.id)
    if(prior) return this.insight.inspect(input.sessionId,input.id)
    const built=buildInsightStudioGraph({sessionId:input.sessionId,context:input.conversationContext,question:input.question,config:preferences.insight})
    const graph:StudioGraph={...built,title:'洞察分析',parameters:{...built.parameters,...(preferences.geminiSemantics?{geminiSemantics:JSON.parse(JSON.stringify(preferences.geminiSemantics))}:{})}}
    const issues=flowReadiness(graph)
    if(issues.length)throw new LlmError(issues.map(i=>i.message).join(' '),'INSIGHT_NOT_CONFIGURED')
    const graphIssues=await this.insight.validate(graph)
    if(graphIssues.length)throw new LlmError(graphIssues.map(i=>i.message).join(' '),'INSIGHT_GRAPH_INVALID')
    await this.capture({id:input.id,graph,runId:input.id},this.pendingRun(input.id,graph))
    this.automaticDelivery.add(`${input.sessionId}:${input.id}`)
    try {
      const run=await this.insight.execute({commandId:input.id,sessionId:input.sessionId,graph,...(input.signal?{signal:input.signal}:{})})
      await this.capture({id:input.id,graph,runId:input.id},run)
      return run
    } catch(error) {
      await this.unknownSource(input.id,input.sessionId,graph,error)
      throw error
    } finally {
      this.automaticDelivery.delete(`${input.sessionId}:${input.id}`)
    }
  }
  override providerInfo(provider:string) { return this.generationMetadata().providerInfo(provider) }
  override providerRetryPolicy(provider:string) { return this.generationMetadata().providerRetryPolicy(provider) }
  private generationMetadata() { return new WebLlmAdapter(this.options.controller) }
  override async listModels(provider:string):Promise<readonly LlmModelInfo[]> { return this.generation(await this.options.preferences.read()).listModels(provider) }
  override async resolveModel(provider:string,model:string,signal?:AbortSignal):Promise<LlmResolvedModelInfo> { return this.generation(await this.options.preferences.read()).resolveModel(provider,model,signal) }
  override async prepareCall(provider:string,model:string,signal?:AbortSignal):Promise<PreparedAdapterCall> {
    const generation=this.generation(await this.options.preferences.read())
    return generation.prepareCall(provider,model,signal)
  }
  override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk> { yield* this.generation(await this.options.preferences.read()).stream(options) }
}
