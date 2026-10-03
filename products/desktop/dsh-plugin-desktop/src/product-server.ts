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
import { prepareProductServerProfile, type PreparedProductServerProfile } from './profile.ts'

const BIN_NAME = 'dsh-product-server'
const SHUTDOWN_TIMEOUT_MS = 5_000

/** Add the immutable deployment role consumed by the Web bundle. */
export function productServerArgs(argv: readonly string[]): string[] {
  return [...argv, '--deployment-role', 'server']
}

/** Differences between the Product Server and a launcher that reuses its lifecycle. */
export interface ProductServerVariant {
  /** Binary name used in diagnostics and layered environment lookup. */
  readonly binName: string
  /** Compose the profile; defaults to the Product Server profile. */
  readonly prepare: (telemetryDisabled: string | undefined, home: string, platform: NodeJS.Platform) => PreparedProductServerProfile
  /** Called once with the booted root context. */
  readonly onBooted?: (ctx: Context) => void
}

/**
 * Start a product tree under plain Node and leave lifetime to its listeners.
 * @param argv - command-line arguments, without the executable.
 * @param variant - launcher-specific naming, profile composition, and readiness hook.
 */
export async function startProductServer(
  argv: readonly string[] = process.argv.slice(2),
  variant: ProductServerVariant = { binName: BIN_NAME, prepare: prepareProductServerProfile },
): Promise<void> {
  const binName = variant.binName
  const environment = loadLayeredEnv(binName, process.cwd())
  const home = resolveDshHome()
  const nativeProductRuntime = installNativeProductRuntime({
    platform: process.platform,
    homeDir: homedir(),
    stateDir: join(home, 'runtime-products'),
    nodeBinDir: dirname(process.execPath),
    environment: process.env,
  })
  const prepared = variant.prepare(process.env.DSH_TELEMETRY_DISABLED, home, process.platform)
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
  installFailLoud(binName, failLoudProcess, dispose)

  try {
    const ctx = await boot(
      binName,
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
    variant.onBooted?.(ctx)
  } catch (cause) {
    await dispose()
    throw cause
  }
}
