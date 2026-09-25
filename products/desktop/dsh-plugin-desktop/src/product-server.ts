/** Headless Host adapter for the complete DSH product composition. */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { installProfilePackageResolver } from './module-resolution.ts'
import { installNativeProductRuntime } from './native-product-runtime.ts'
import { prepareProductServerProfile } from './profile.ts'

const BIN_NAME = 'dsh-product-server'
const SHUTDOWN_TIMEOUT_MS = 5_000

/** Add the immutable deployment role consumed by the Web bundle. */
export function productServerArgs(argv: readonly string[]): string[] {
  return [...argv, '--deployment-role', 'server']
}

/** Start the full product tree under plain Node and leave lifetime to its listeners. */
export async function startProductServer(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const environment = loadLayeredEnv(BIN_NAME, process.cwd())
  const home = resolveDshHome()
  const nativeProductRuntime = installNativeProductRuntime({
    platform: process.platform,
    homeDir: homedir(),
    stateDir: join(home, 'runtime-products'),
    nodeBinDir: dirname(process.execPath),
    environment: process.env,
  })
  const prepared = prepareProductServerProfile(
    process.env.DSH_TELEMETRY_DISABLED,
    home,
    process.platform,
  )
  const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  let current: Context | undefined
  let shutdownTask: Promise<void> | undefined
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined

  const dispose = async (): Promise<void> => {
    try {
      await current?.fiber.dispose()
    } finally {
      releasePackageResolver()
      nativeProductRuntime.dispose()
    }
  }
  const shutdown = (code: number, forceAfter: boolean): Promise<void> => {
    if (shutdownTask !== undefined) {
      if (forceAfter) process.exit(code)
      return shutdownTask
    }
    shutdownTimer = setTimeout(() => { process.exit(code) }, SHUTDOWN_TIMEOUT_MS)
    shutdownTask = dispose().then(
      () => {
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
        if (forceAfter) process.exit(code)
        process.exitCode = code
      },
      () => { process.exit(code) },
    )
    return shutdownTask
  }
  const interrupt = (code: number): void => { void shutdown(code, true) }
  process.once('SIGTERM', () => { interrupt(0) })
  process.once('SIGINT', () => { interrupt(130) })

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: code => { process.exit(code) },
  }
  installFailLoud(BIN_NAME, failLoudProcess, dispose)

  try {
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      (hostCtx) => {
        current = hostCtx
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-product-server: profile package resolution',
        )
        hostCtx.effect(
          () => () => { nativeProductRuntime.dispose() },
          'dsh-product-server: native product command PATH',
        )
        provideCmdline(hostCtx, {
          args: productServerArgs(argv),
          exit: code => { void shutdown(code, false) },
        })
      },
      prepared.bareModuleBaseUrl,
    )
    current = ctx
  } catch (cause) {
    await dispose()
    throw cause
  }
}
