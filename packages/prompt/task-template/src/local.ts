/**
 * File-backed task-template provider. One JSON document holds every template
 * and the personalization layer; its location comes strictly from explicit
 * configuration or the DSH private-data root (`$DSH_HOME`, default `~/.dsh`),
 * never from the repository or the working directory. Every read passes the
 * store document's trust-boundary validation; a corrupt or unsupported
 * document fails the boot loud instead of being silently replaced.
 *
 * A document write elsewhere on the same host (another CLI invocation, the
 * Desktop UI's own process editing the store through its own instance of this
 * provider) hot-publishes through the seam: a monitor polls the file, and
 * a settled reconcile queue folds the on-disk change into this process's live
 * document, so an already-running Consumer (a long-lived TaskGraph daemon
 * holding this same service instance) sees the new content on its next
 * `select` without restarting. Every write re-reads under a cross-process
 * writer lock before persisting, so a write here can never resurrect a
 * document an external edit already replaced.
 *
 * 文件后端的任务模板 Provider。单个 JSON 文档保存全部模板与个性化层；其位置
 * 严格来自显式配置或 DSH 私有数据根（`$DSH_HOME`，默认 `~/.dsh`），绝不来自
 * 仓库或工作目录。所有读取都经过存储文档的信任边界校验；损坏或不支持的文档
 * 在启动时立即报错，绝不静默覆盖。
 *
 * 同一主机上其他进程（另一次 CLI 调用、桌面 UI 自身进程通过自己的 Provider
 * 实例编辑存储）的写入会通过接缝热发布：监视器轮询文件变化，串行化的
 * 协调队列把磁盘变更并入本进程的活动文档，使已运行的 Consumer（持有同一
 * 服务实例的长驻 TaskGraph 守护进程）无需重启即可在下次 `select` 时看到新
 * 内容。每次写入都会在跨进程写锁下重新读取后再持久化，因此本进程的写入
 * 绝不会覆盖外部编辑已经替换掉的文档。
 *
 * @module @deepseek-ai/dsh-task-template/local
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TaskTemplateService } from './service.ts'
import { emptyStoreDocument, parseStoreDocument, renderStoreDocument } from './store.ts'
import type { TaskTemplateStoreDocument } from './store.ts'

/** Plugin config: where the template store document lives and its hot-reload behavior. 插件配置：存储文档位置与热重载行为。 */
export interface Config {
  /** Store document path; must end in `.json`. Defaults to `task-templates.json` under the DSH home. 文档路径。 */
  path?: string
  /** DSH home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. 私有数据根。 */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. 是否监视文档并热发布外部编辑，默认 true。 */
  watch?: boolean
  /** External-change polling interval in milliseconds; defaults to 100. 外部变更轮询间隔（毫秒），默认 100。 */
  pollIntervalMs?: number
}

/**
 * Resolve the store document path from plugin config: an explicit `path`
 * wins, otherwise the document lives at `<DSH home>/task-templates.json`.
 * Blank values and non-`.json` extensions are configuration errors and fail
 * loud at load.
 * @param config - raw plugin config.
 * @returns the absolute store document path.
 */
export function resolveStorePath(config: Config): string {
  if (config.path !== undefined) {
    if (config.path.trim().length === 0) {
      throw new Error('task-template: config "path" must be non-blank when present')
    }
    const filename = resolve(config.path)
    if (extname(filename) !== '.json') {
      throw new Error(`task-template: store extension "${extname(filename)}" is not supported (use .json)`)
    }
    return filename
  }
  if (config.dshHome !== undefined && config.dshHome.trim().length === 0) {
    throw new Error('task-template: config "dshHome" must be non-blank when present')
  }
  return resolve(join(resolveDshHome(config.dshHome), 'task-templates.json'))
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** File-backed task-template provider (`task-templates.json`). */
export class FileTaskTemplateProvider extends TaskTemplateService {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    pollIntervalMs: z.number().min(1).default(100),
  })

  /** Resolved absolute store document path. */
  private readonly filename: string
  /** Whether to watch {@link filename} and hot-publish external edits. */
  private readonly watch: boolean
  /** External-change polling interval in milliseconds. */
  private readonly pollIntervalMs: number
  /**
   * Raw text of the last successfully read or persisted document;
   * `undefined` while the file is absent. A watcher event whose content
   * equals this cache is a no-op — this is also this provider's own writes'
   * self-suppression, so persisting never re-triggers its own reload.
   */
  private text: string | undefined
  /** Set at service dispose: stop reacting to watcher events. */
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.filename = resolveStorePath(config)
    this.watch = config.watch ?? true
    this.pollIntervalMs = config.pollIntervalMs ?? 100
  }

  /** The resolved store document path, for diagnostics and tests. 存储文档绝对路径。 */
  get documentPath(): string {
    return this.filename
  }

  protected async load(): Promise<TaskTemplateStoreDocument> {
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.text = undefined
      return emptyStoreDocument()
    }
    const document = parseStoreDocument(text, this.filename)
    this.text = text
    return document
  }

  protected async persist(document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'> {
    // The writer lock's exclusive create needs the parent directory to exist
    // before writeFileAtomic gets its own chance to create it.
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      // One last re-read INSIDE the exclusive lock: `document` was derived
      // from `this.text` as {@link reconcileBeforeWrite} last left it, so any
      // further change since then — an external process's write landing in
      // the narrow window between that reconcile and this lock acquisition —
      // must still be caught here, or this write would silently revert it.
      // An unreadable or invalid on-disk document fails the write loud
      // instead of silently overwriting it. This already runs inside
      // {@link TaskTemplateService}'s one operation queue (the pending
      // `write` this `persist` is part of), so a genuine change adopts
      // directly instead of calling `refresh`, which would queue behind —
      // and deadlock waiting for — that same in-flight write.
      const observed = await this.readDocument()
      if (observed !== undefined) {
        this.adoptWithinWrite(observed)
        return 'stale'
      }
      const output = renderStoreDocument(document)
      // 0600/0700: the store may hold personal preference and memory content
      // and must never be group- or world-readable.
      await writeFileAtomic(this.filename, output, { mode: 0o600, dirMode: 0o700 })
      this.text = output
      return 'committed'
    })
  }

  protected override async reconcileBeforeWrite(): Promise<void> {
    const observed = await this.readDocument()
    if (observed !== undefined) this.adoptWithinWrite(observed)
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and commits the initial document; a validation
    // failure aborts service initialization.
    yield* super[Service.init]()
    if (!this.watch) return
    let timer: NodeJS.Timeout | undefined
    const reconcile = (): Promise<void> => this.enqueueRefresh().catch((error: unknown) => {
      // Only an invariant violation escaping the commit can reject a
      // reconcile; keep the monitor alive and surface it as an error so one
      // poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.error('task-template: reload commit failed at %s', this.filename)
      this.ctx.logger.error(error)
    })
    const schedule = (): void => {
      if (this.closed) return
      timer = setTimeout(() => {
        timer = undefined
        void reconcile().finally(schedule)
      }, this.pollIntervalMs)
      timer.unref()
    }
    // Close the gap between the initial load and the first scheduled poll.
    await reconcile()
    schedule()
    yield () => {
      // Stop future polls, then let {@link TaskTemplateService}'s own drain
      // settle any refresh already in the operation queue.
      this.closed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Read the document when its text differs from the cache, updating the
   * cache as the read's side effect. Callers hold exclusivity over
   * {@link text} by construction: a queued write and a queued refresh never
   * run concurrently (one operation queue), and `persist` reads and updates
   * it from inside the writer lock before any concurrently queued refresh
   * could observe a half-committed value.
   * @returns the freshly parsed document, or `undefined` when the on-disk
   * text is unchanged since the last successful read or persist.
   */
  private async readDocument(): Promise<TaskTemplateStoreDocument | undefined> {
    let text: string | undefined
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text) return undefined
    const document = text === undefined ? emptyStoreDocument() : parseStoreDocument(text, this.filename)
    this.text = text
    return document
  }

  /**
   * Queue one poll-triggered reload behind every earlier write and
   * reload, through {@link TaskTemplateService.refresh}, so the read always
   * happens after any write already queued ahead of it committed and can
   * never race that write's own {@link readDocument} call. Publishes the
   * result only when the document actually changed. An unreadable or invalid
   * document propagates so a corrupt external edit is never silently
   * adopted; the monitor keeps running and the next successful read recovers.
   */
  private enqueueRefresh(): Promise<void> {
    return this.refresh(() => {
      /* v8 ignore next -- only a poll already queued when disposal begins can observe closed here */
      return this.closed ? Promise.resolve(undefined) : this.readDocument()
    })
  }
}

export default FileTaskTemplateProvider
