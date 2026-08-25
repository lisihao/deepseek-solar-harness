/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, net, safeStorage } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { installDesktopPnpmRuntime } from './desktop-runtime-environment.ts'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { installNativeProductRuntime } from './native-product-runtime.ts'
import { packagedDependencyPath, unpackedAsarPath } from './packaged-runtime-path.ts'
import {
  activeFrontendServer,
  DesktopDeploymentStateStore,
  DesktopRemoteAccessSession,
  type DesktopDeploymentState,
} from './deployment-state.ts'
import { parseFrontendBillingBaseline, type FrontendBillingBaseline } from './frontend-billing.ts'
import { FrontendSetupController } from './frontend-setup.ts'
import {
  beginDesktopProfileStartup,
  listDesktopProfiles,
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  selectDesktopProfile,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { prepareDesktopProfile } from './profile.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PRODUCT_NAME = 'DSH Desktop'

/** Read the inactive local Host's billing totals for an explicit Frontend history baseline. */
async function readFrontendBillingBaseline(): Promise<FrontendBillingBaseline | undefined> {
  const path = join(resolveDshHome(), 'storages', 'web-billing.json')
  try {
    return parseFrontendBillingBaseline(JSON.parse(await readFile(path, 'utf8')))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `${BIN_NAME}: unable to read local billing baseline: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      )
    }
    return undefined
  }
}

/** Resolve a packaged Desktop asset without depending on the Cordis shell plugin. */
function desktopAssetPath(filename: string): string {
  return unpackedAsarPath(fileURLToPath(new URL(`../build/${filename}`, import.meta.url)))
}

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let current: Context | undefined
  let profileStartup: DesktopProfileStartup | undefined
  let profileStatePath: string | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let disposePnpmRuntime: (() => void) | undefined
  let disposeNativeProductRuntime: (() => void) | undefined
  let disposeFrontend: (() => Promise<void>) | undefined
  let frontendAccess: DesktopRemoteAccessSession | undefined
  let frontendSetup: FrontendSetupController | undefined
  let deploymentStore: DesktopDeploymentStateStore | undefined
  let deploymentState: DesktopDeploymentState = { version: 3, role: 'server' }
  let runtime!: ElectronDesktopRuntime
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => { removeShutdownRequests?.() },
  )
  let restartRequested = false
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, {
    currentRole: () => deploymentState.role,
    configureFrontend: async () => {
      if (frontendSetup === undefined) throw new Error('dsh-plugin-desktop: Frontend setup is not ready')
      await frontendSetup.open()
    },
    useServer: async () => {
      if (deploymentStore === undefined) throw new Error('dsh-plugin-desktop: deployment state is not ready')
      deploymentState = await deploymentStore.useServer()
      await runtime.requestRestart()
    },
  })
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => {
      try {
        await disposeFrontend?.()
      } finally {
        try {
          await current?.fiber.dispose()
        } finally {
          try {
            frontendAccess?.stop()
            frontendSetup?.dispose()
            disposeNativeProductRuntime?.()
          } finally {
            disposePnpmRuntime?.()
          }
        }
      }
    },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', () => { runtime.show() })
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.dsh.desktop')
  if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    try {
      await disposeFrontend?.()
    } finally {
      try {
        await current?.fiber.dispose()
      } finally {
        try {
          frontendAccess?.stop()
          frontendSetup?.dispose()
          disposeNativeProductRuntime?.()
        } finally {
          disposePnpmRuntime?.()
        }
      }
    }
  })

  try {
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    process.env.DSH_BUILD_COMMIT ??= app.isPackaged ? `desktop-${app.getVersion()}` : 'development'
    deploymentStore = new DesktopDeploymentStateStore(
      app.getPath('userData'),
      safeStorage,
      { fetch: (url, init) => net.fetch(String(url), init) },
    )
    deploymentState = await deploymentStore.load()
    frontendSetup = new FrontendSetupController(
      deploymentStore,
      () => deploymentState,
      () => runtime.requestRestart(),
    )
    if (deploymentState.role === 'frontend') {
      const state = deploymentState
      const server = activeFrontendServer(state)
      const access = server.authMode === 'paired'
        ? new DesktopRemoteAccessSession(deploymentStore, server, (cause) => {
            process.stderr.write(
              `${BIN_NAME}: failed to refresh remote access: ${cause instanceof Error ? cause.message : String(cause)}\n`,
            )
          })
        : undefined
      try {
        await access?.start()
        frontendAccess = access
        const endpoint = new URL(server.endpoint)
        const renderer = new URL(endpoint)
        renderer.searchParams.set('dsh-deployment-role', 'frontend')
        renderer.searchParams.set('dsh-desktop-mode', state.presentation)
        renderer.searchParams.set('dsh-desktop-platform', process.platform)
        renderer.searchParams.set('dsh-desktop-version', runtime.updates.currentVersion)
        const billingBaseline = await readFrontendBillingBaseline()
        if (billingBaseline !== undefined) {
          renderer.searchParams.set('dsh-local-billing-baseline', JSON.stringify(billingBaseline))
        }
        const release = runtime.schedule({
          mode: state.presentation,
          width: 1280,
          height: 840,
          minWidth: 900,
          minHeight: 640,
          url: renderer.href,
          productName: PRODUCT_NAME,
          windowTitle: 'DSH Desktop · Remote Frontend',
          iconPath: desktopAssetPath(process.platform === 'darwin' ? 'app-icon-mac.png' : 'app-icon.png'),
          trayIcons: {
            templatePath: desktopAssetPath('tray-iconTemplate.png'),
            bluePath: desktopAssetPath('tray-icon-blue.png'),
          },
          ...access === undefined ? {} : {
            remoteAccess: {
              origin: endpoint.origin,
              accessToken: () => access.accessToken(),
            },
          },
          readThemeSource: () => 'system',
          requestQuit,
          requestModeChange: async (mode) => {
            deploymentState = await deploymentStore!.setPresentation(state, mode)
            await runtime.requestRestart()
          },
          requestUseLocalServer: async () => {
            deploymentState = await deploymentStore!.useServer()
            await runtime.requestRestart()
          },
        })
        disposeFrontend = release
        await runtime.mountScheduled()
      } catch (cause) {
        access?.stop()
        frontendAccess = undefined
        process.stderr.write(
          `${BIN_NAME}: unable to open remote Frontend: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        )
        await frontendSetup.open()
      }
      return
    }
    const electronVersion = process.versions.electron
    if (electronVersion === undefined) {
      throw new Error(`${BIN_NAME}: plugin runtime requires the Electron runtime version`)
    }
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: process.platform,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      stateDir: join(app.getPath('userData'), 'runtime-commands'),
      environment: process.env,
    })
    const releasePnpmRuntime = (): void => { pnpmRuntime.dispose() }
    disposePnpmRuntime = releasePnpmRuntime
    const nativeProductRuntime = installNativeProductRuntime({
      platform: process.platform,
      homeDir: app.getPath('home'),
      stateDir: join(app.getPath('userData'), 'runtime-products'),
      environment: process.env,
    })
    const releaseNativeProductRuntime = (): void => { nativeProductRuntime.dispose() }
    disposeNativeProductRuntime = releaseNativeProductRuntime
    const homeDir = resolveDshHome()
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    profileStatePath = selectionStatePath
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
    )
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
      dshBootstrapPath: fileURLToPath(new URL('./desktop-cli.js', import.meta.url)),
    }
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        hostCtx.effect(
          () => releasePnpmRuntime,
          'dsh-plugin-desktop: packaged pnpm runtime PATH',
        )
        hostCtx.effect(
          () => releaseNativeProductRuntime,
          'dsh-plugin-desktop: native product command PATH',
        )
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          list: () => listDesktopProfiles(homeDir),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', '0'],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    current = ctx
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    await runtime.mountScheduled(() => {
      markDesktopProfileHealthy(selectionStatePath, activeProfileName)
    })
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
  } catch (cause) {
    process.stderr.write(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    let exitCode = 1
    if (profileStartup !== undefined && profileStatePath !== undefined) {
      const retryLastKnownGood = profileStartup.profileName !== profileStartup.state.lastKnownGood
      try {
        markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
        if (retryLastKnownGood) {
          nativeExit.requestRelaunch()
          exitCode = 0
          notifyProfileRecovery(
            runtime,
            `Reopening last-known-good profile ${profileStartup.state.lastKnownGood}.`,
          )
        }
      } catch (stateCause) {
        process.stderr.write(`${BIN_NAME}: failed to roll back desktop profile state: ${stateCause instanceof Error ? stateCause.message : String(stateCause)}\n`)
      }
    }
    await shutdown.request(exitCode)
  }
}

void start()
