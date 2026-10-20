import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { WebRunStore } from './store.js'
import { WebController } from './controller.js'
import { EgoWebAdapter } from './ego-adapter.js'
import { WebControl } from './control.js'
import { createWebProvider, createWebTool } from './bindings.js'

export const name = 'chatgpt-web'
export const inject = ['tools', 'subagents']
export interface Config {
  readonly executablePath: string
  readonly taskSpaceId: number
  readonly commandTimeoutMs: number
  readonly runTimeoutMs: number
  readonly pollMs: number
  readonly maxOutputBytes: number
  readonly modelLabel: string
  readonly effortLabel: string
}
export const Config: z<Config> = z.object({
  executablePath: z.string().default(join(homedir(), '.local', 'bin', 'ego-browser')),
  taskSpaceId: z.number().min(0).default(0),
  commandTimeoutMs: z.number().min(5_000).max(60_000).default(25_000),
  runTimeoutMs: z.number().min(10_000).max(600_000).default(300_000),
  pollMs: z.number().min(1_000).max(30_000).default(2_000),
  maxOutputBytes: z.number().min(1024).max(8 * 1024 * 1024).default(1024 * 1024),
  modelLabel: z.string().default(''),
  effortLabel: z.string().default(''),
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
  const defaults = {
    ...(config.modelLabel.trim() ? { modelLabel: config.modelLabel.trim() } : {}),
    ...(config.effortLabel.trim() ? { effortLabel: config.effortLabel.trim() } : {}),
  }
  new WebControl(ctx, controller, defaults)
  ctx.effect(() => {
    const unregisterProvider = ctx.subagents.registerProvider(createWebProvider(controller, defaults))
    const unregisterTool = ctx.tools.register(createWebTool(controller, defaults))
    return () => { unregisterTool(); unregisterProvider() }
  })
  ctx.effect(() => () => controller.dispose())
}
