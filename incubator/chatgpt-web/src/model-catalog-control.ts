import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { WebBrowserAdapter } from './browser-contract.js'
import type { WebModelCatalog, WebModelCatalogApi, WebModelCatalogRefreshInput } from './model-catalog.js'

const refreshSchema = z.strictObject({ modelLabel: z.string().trim().max(120).optional() })
type CatalogBrowser = Pick<WebBrowserAdapter, 'create' | 'finish'> & {
  catalog(resource: Awaited<ReturnType<WebBrowserAdapter['create']>>, input: WebModelCatalogRefreshInput, signal?: AbortSignal): Promise<WebModelCatalog>
}

/** Volatile discovery cache. Execution always checks its own target page again. */
export class ModelCatalogControl extends TypertRemoteService implements WebModelCatalogApi {
  private cached?: WebModelCatalog
  private pending?: { readonly key: string; readonly promise: Promise<WebModelCatalog> }
  private disposed = false
  private readonly abort = new AbortController()
  private uncertain?: string

  constructor(ctx: Context, private readonly browser: CatalogBrowser, private readonly isBusy: () => Promise<boolean> = async () => false) {
    super(ctx, 'solarWebModelCatalog')
    ctx.effect(() => () => {
      this.disposed = true
      this.abort.abort()
    })
  }
  private owner(): void {
    if (this.ctx.invocation !== undefined && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: 模型目录仅允许本机所有者读取。')
    }
    if (this.disposed) throw new Error('WEB_CATALOG_DISPOSED: 模型目录服务已停止。')
  }
  @Remote
  async read(): Promise<WebModelCatalog | undefined> {
    this.owner()
    return this.cached === undefined ? undefined : structuredClone(this.cached)
  }
  @Remote
  async refresh(input: WebModelCatalogRefreshInput): Promise<WebModelCatalog> {
    this.owner()
    const value = refreshSchema.parse(input)
    if (this.uncertain) throw new Error(this.uncertain)
    const key = value.modelLabel ?? ''
    if (this.pending) {
      if (this.pending.key !== key) throw new Error('WEB_CATALOG_BUSY: 正在读取另一个模型的目录，请等待完成。')
      return structuredClone(await this.pending.promise)
    }
    const promise = Promise.resolve().then(async () => {
      if (await this.isBusy()) throw new Error('WEB_CATALOG_BUSY: 当前网页任务尚未结束，请先检查原任务状态。')
      let resource: Awaited<ReturnType<CatalogBrowser['create']>> | undefined
      let finishStarted = false
      try {
        resource = await this.browser.create(`catalog-${randomUUID()}`, this.abort.signal)
        const catalog = await this.browser.catalog(resource, value, this.abort.signal)
        finishStarted = true
        await this.browser.finish(resource)
        if (this.disposed) throw new Error('WEB_CATALOG_DISPOSED: 模型目录服务已停止。')
        this.cached = structuredClone(catalog)
        return catalog
      } catch (error) {
        const mayHaveLateEffects = typeof error === 'object' && error !== null && 'mayHaveLateEffects' in error && error.mayHaveLateEffects === true
        if (mayHaveLateEffects) {
          this.uncertain = 'WEB_CATALOG_OBSERVATION_UNKNOWN: 目录读取尚未确认结束；请检查原目标浏览器窗口，未重试或关闭该窗口。'
        } else if (resource !== undefined && !finishStarted) {
          // The adapter has settled/restored its menu before reporting a known failure.
          // An unknown selection-restoration error keeps the page for inspection.
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          if (code === 'WEB_SELECTION_RESTORE_FAILED') {
            this.uncertain = 'WEB_CATALOG_SELECTION_UNKNOWN: 无法确认目标浏览器已恢复原选择；请检查原窗口，未重试。'
          } else {
            await this.browser.finish(resource)
          }
        }
        throw error
      }
    })
    this.pending = { key, promise }
    try { return structuredClone(await promise) }
    finally { if (this.pending?.promise === promise) this.pending = undefined }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarWebModelCatalog: ModelCatalogControl } }
