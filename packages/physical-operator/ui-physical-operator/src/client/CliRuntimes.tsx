import { useCallback, useEffect, useState } from 'react'
import type {
  DesktopResidentCliProduct,
  DesktopResidentCliRuntime,
  DesktopResidentCliRuntimes,
  DesktopResidentCliUpdate,
} from '../contracts.ts'
import { RESIDENT_CLI_PATH } from '../contracts.ts'
import type { BrowserRequest } from './ResidentOperatorsPanel.tsx'

const PRODUCT_NAMES: Record<DesktopResidentCliProduct, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

async function cliRequest<T>(request: BrowserRequest, init: RequestInit, product?: DesktopResidentCliProduct): Promise<T> {
  const url = new URL(RESIDENT_CLI_PATH, window.location.origin)
  if (product !== undefined) url.searchParams.set('product', product)
  const response = await request(url, { cache: 'no-store', ...init })
  if (!response.ok) {
    const body = await response.text()
    let message = body
    try {
      const parsed = JSON.parse(body) as { message?: unknown }
      if (typeof parsed.message === 'string') message = parsed.message
    } catch {
      // A non-JSON Host failure is shown as its bounded response text.
    }
    throw new Error(`原生 CLI 操作失败（${String(response.status)}）：${message}`)
  }
  return await response.json() as T
}

/**
 * Read each native CLI's running version and the registry's newest version.
 * @param request - authenticated same-origin browser request.
 * @param signal - local cancellation for the browser request.
 * @returns one runtime status per native product.
 */
export async function loadCliRuntimes(request: BrowserRequest, signal?: AbortSignal): Promise<DesktopResidentCliRuntime[]> {
  return (await cliRequest<DesktopResidentCliRuntimes>(request, signal === undefined ? {} : { signal })).runtimes
}

/**
 * Download, qualify, and activate the newest CLI of one product.
 * @param product - native product to update.
 * @param request - authenticated same-origin browser request.
 * @returns the candidate version and whether it was activated.
 */
export async function updateCliRuntime(
  product: DesktopResidentCliProduct,
  request: BrowserRequest,
): Promise<DesktopResidentCliUpdate> {
  return cliRequest<DesktopResidentCliUpdate>(request, { method: 'POST' }, product)
}

function outcome(result: DesktopResidentCliUpdate, previous: string | undefined): string {
  const name = PRODUCT_NAMES[result.product]
  return result.status === 'activated'
    ? `${name} 已切换到 ${result.version}，下一次任务起生效，无需重启 DSH。`
    : `${name} ${result.version} 未通过 DSH 兼容验证，继续使用 ${previous ?? '当前版本'}，需等待 DSH 适配：${result.reason ?? ''}`
}

/** Native CLI version check and verified one-click update for the Resident panel. */
export function CliRuntimesSection({ request, localOwner, onUpdated }: {
  request: BrowserRequest
  /** Whether this browser runs on the Host machine; updates are local-owner actions. */
  localOwner: boolean
  /** Refresh dependent provider status after a successful activation. */
  onUpdated: () => void
}) {
  const [runtimes, setRuntimes] = useState<DesktopResidentCliRuntime[]>()
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<DesktopResidentCliProduct>()
  const [message, setMessage] = useState<string>()

  const check = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setChecking(true)
    try {
      setRuntimes(await loadCliRuntimes(request, signal))
    } catch (cause) {
      if (signal?.aborted !== true) setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (signal?.aborted !== true) setChecking(false)
    }
  }, [request])

  useEffect(() => {
    const controller = new AbortController()
    void check(controller.signal)
    return () => { controller.abort() }
  }, [check])

  const update = async (runtime: DesktopResidentCliRuntime): Promise<void> => {
    setUpdating(runtime.product)
    setMessage(undefined)
    try {
      const result = await updateCliRuntime(runtime.product, request)
      setMessage(outcome(result, runtime.currentVersion))
      if (result.status === 'activated') onUpdated()
      await check()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUpdating(undefined)
    }
  }

  return (
    <>
      <h3>CLI 版本</h3>
      <div className="dshDesktopResidentProviders" aria-label="原生 CLI 版本">
        {runtimes?.map(runtime => (
          <div key={runtime.product} className="dshDesktopResidentProvider" data-ok={!runtime.updateAvailable || undefined}>
            <span className="dshDesktopResidentDot" />
            <div>
              <strong>{PRODUCT_NAMES[runtime.product]}{runtime.managed ? ' · DSH 托管' : ''}</strong>
              <small>当前 {runtime.currentVersion ?? '未安装'} · 最新 {runtime.latestVersion ?? '未知'}</small>
              {runtime.error !== undefined && <small>{runtime.error}</small>}
              {runtime.updateAvailable && runtime.latestVersion !== undefined && (localOwner
                ? <button
                  type="button"
                  className="dshDesktopResidentAuthenticate"
                  disabled={updating !== undefined}
                  onClick={() => { void update(runtime) }}
                >
                  {updating === runtime.product ? '正在下载并验证…' : `验证并更新到 ${runtime.latestVersion}`}
                </button>
                : <small>请在服务器本机更新</small>)}
              {runtime.updateAvailable && runtime.product === 'codex' && (
                <small>Codex 通过其自带的 app-server 更新生效，会中断正在运行的 Codex 任务。</small>
              )}
            </div>
            <em>{runtime.updateAvailable ? '有新版本' : '已是最新'}</em>
          </div>
        )) ?? <p>{checking ? '正在检查新版本…' : '尚未检查'}</p>}
      </div>
      <button
        type="button"
        className="dshDesktopResidentAuthenticate"
        disabled={checking || updating !== undefined}
        onClick={() => { setMessage(undefined); void check() }}
      >
        {checking ? '正在检查…' : '检查更新'}
      </button>
      {message !== undefined && <p className="dshDesktopResidentHelp" role="status">{message}</p>}
    </>
  )
}
