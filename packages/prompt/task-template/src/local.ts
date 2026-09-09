/**
 * File-backed task-template provider. One JSON document holds every template
 * and the personalization layer; its location comes strictly from explicit
 * configuration or the DSH private-data root (`$DSH_HOME`, default `~/.dsh`),
 * never from the repository or the working directory. Every read passes the
 * store document's trust-boundary validation; a corrupt or unsupported
 * document fails the boot loud instead of being silently replaced.
 *
 * 文件后端的任务模板 Provider。单个 JSON 文档保存全部模板与个性化层；其位置
 * 严格来自显式配置或 DSH 私有数据根（`$DSH_HOME`，默认 `~/.dsh`），绝不来自
 * 仓库或工作目录。所有读取都经过存储文档的信任边界校验；损坏或不支持的文档
 * 在启动时立即报错，绝不静默覆盖。
 *
 * @module @deepseek-ai/dsh-task-template/local
 */

import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TaskTemplateService } from './service.ts'
import { emptyStoreDocument, parseStoreDocument, renderStoreDocument } from './store.ts'
import type { TaskTemplateStoreDocument } from './store.ts'

/** Plugin config: where the template store document lives. 插件配置：存储文档位置。 */
export interface Config {
  /** Store document path; must end in `.json`. Defaults to `task-templates.json` under the DSH home. 文档路径。 */
  path?: string
  /** DSH home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. 私有数据根。 */
  dshHome?: string
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
  })

  /** Resolved absolute store document path. */
  private readonly filename: string

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the location in one explicit step either way.
    this.filename = resolveStorePath(config)
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
      return emptyStoreDocument()
    }
    return parseStoreDocument(text, this.filename)
  }

  protected persist(document: TaskTemplateStoreDocument): Promise<void> {
    // 0600/0700: the store may hold personal preference and memory content
    // and must never be group- or world-readable.
    return writeFileAtomic(this.filename, renderStoreDocument(document), { mode: 0o600, dirMode: 0o700 })
  }
}

export default FileTaskTemplateProvider
