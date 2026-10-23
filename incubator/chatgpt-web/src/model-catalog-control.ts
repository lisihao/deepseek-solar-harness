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

type CatalogStage = 'create' | 'catalog' | 'finish' | 'cleanup'

type CatalogFailure = {
  readonly stage: CatalogStage
  readonly stageCode: string
  readonly code: string
}

const CATALOG_STAGE_CODES: Readonly<Record<CatalogStage, string>> = {
  create: 'WEB_CATALOG_CREATE_FAILED',
  catalog: 'WEB_CATALOG_READ_FAILED',
  finish: 'WEB_CATALOG_FINISH_FAILED',
  cleanup: 'WEB_CATALOG_CLEANUP_FAILED',
}

const CATALOG_STAGE_LABELS: Readonly<Record<CatalogStage, string>> = {
  create: '创建目标',
  catalog: '读取',
  finish: '完成并清理',
  cleanup: '清理目标',
}

const SAFE_BROWSER_CODE = /^(?:WEB|EGO)_[A-Z0-9_]+$/
const SAFE_BROWSER_CODE_MAX_LENGTH = 96

function catalogFailure(stage: CatalogStage, error: unknown): CatalogFailure {
  const stageCode = CATALOG_STAGE_CODES[stage]
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return {
    stage,
    stageCode,
    code: typeof candidate === 'string'
      && candidate.length <= SAFE_BROWSER_CODE_MAX_LENGTH
      && SAFE_BROWSER_CODE.test(candidate)
      ? candidate
      : stageCode,
  }
}

function catalogFailureMessage(primary: CatalogFailure, cleanup?: CatalogFailure): string {
  const primaryMessage = `${primary.stageCode}: 模型目录${CATALOG_STAGE_LABELS[primary.stage]}失败；错误码 ${primary.code}；未自动重试。`
  if (cleanup === undefined) return primaryMessage
  return `${primaryMessage}${cleanup.stageCode}: 模型目录${CATALOG_STAGE_LABELS[cleanup.stage]}失败；错误码 ${cleanup.code}；未自动重试。`
}

function catalogFailureError(primary: CatalogFailure, cleanup?: CatalogFailure): Error {
  return new Error(catalogFailureMessage(primary, cleanup))
}

function mayHaveLateEffects(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'mayHaveLateEffects' in error && error.mayHaveLateEffects === true
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
      let stage: CatalogStage = 'create'
      try {
        resource = await this.browser.create(`catalog-${randomUUID()}`, this.abort.signal)
        stage = 'catalog'
        const catalog = await this.browser.catalog(resource, value, this.abort.signal)
        stage = 'finish'
        await this.browser.finish(resource)
        if (this.disposed) throw new Error('WEB_CATALOG_DISPOSED: 模型目录服务已停止。')
        this.cached = structuredClone(catalog)
        return catalog
      } catch (error) {
        const primary = catalogFailure(stage, error)
        if (mayHaveLateEffects(error)) {
          this.uncertain = 'WEB_CATALOG_OBSERVATION_UNKNOWN: 目录读取尚未确认结束；请检查原目标浏览器窗口，未重试或关闭该窗口。'
        } else if (resource !== undefined && stage === 'catalog') {
          // The adapter has settled/restored its menu before reporting a known failure.
          // An unknown selection-restoration error keeps the page for inspection.
          if (primary.code === 'WEB_SELECTION_RESTORE_FAILED') {
            this.uncertain = 'WEB_CATALOG_SELECTION_UNKNOWN: 无法确认目标浏览器已恢复原选择；请检查原窗口，未重试。'
          } else {
            try {
              await this.browser.finish(resource)
            } catch (cleanupError) {
              throw catalogFailureError(primary, catalogFailure('cleanup', cleanupError))
            }
          }
        }
        throw catalogFailureError(primary)
      }
    })
    this.pending = { key, promise }
    try { return structuredClone(await promise) }
    finally { if (this.pending?.promise === promise) this.pending = undefined }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarWebModelCatalog: ModelCatalogControl } }
