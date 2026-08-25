import type { DesktopClientEnvironment } from './environment.ts'

/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

/** Exact custom navigation consumed by the trusted Electron shell. */
export const USE_LOCAL_SERVER_URL = 'dsh-desktop://deployment/local-server'
/** Open native Server and Git synchronization configuration. */
export const CONFIGURE_DEPLOYMENT_URL = 'dsh-desktop://deployment/configure'

/** Complete accessible product marker with the running package version. */
export function solarBrandLabel(productVersion: string): string {
  return `DSH Desktop v${productVersion} · ${SOLAR_BRAND}`
}

/** Mount the persistent one-line product marker below the complete application surface. */
export function mountSolarBrandFooter(environment: DesktopClientEnvironment): () => void {
  const label = solarBrandLabel(environment.productVersion)
  const footer = document.createElement('footer')
  footer.className = 'dshDesktopSolarFooter'
  footer.dataset.testid = 'solar-desktop-brand'
  footer.setAttribute('role', 'note')
  footer.setAttribute('aria-label', label)
  footer.title = label
  const marker = document.createElement('span')
  marker.className = 'dshDesktopSolarFooterLabel'
  marker.textContent = label
  footer.appendChild(marker)
  if (environment.deploymentRole === 'frontend') {
    const configure = document.createElement('button')
    configure.type = 'button'
    configure.className = 'dshDesktopUseLocalServer'
    configure.dataset.testid = 'desktop-configure-deployment'
    configure.textContent = 'Server / Git 同步'
    configure.title = '配置远程 Server 与仅提交态的 GitHub/Tailscale Git 同步'
    configure.addEventListener('click', () => { window.location.assign(CONFIGURE_DEPLOYMENT_URL) })
    footer.appendChild(configure)
    const useLocal = document.createElement('button')
    useLocal.type = 'button'
    useLocal.className = 'dshDesktopUseLocalServer'
    useLocal.dataset.testid = 'desktop-use-local-server'
    useLocal.textContent = '切换到本地 Server'
    useLocal.title = '停止使用远程 Frontend，并以本机完整 DSH Server 重启'
    useLocal.addEventListener('click', () => { window.location.assign(USE_LOCAL_SERVER_URL) })
    footer.appendChild(useLocal)
  }

  document.body.dataset.dshDesktopProductFooter = 'true'
  document.body.appendChild(footer)

  return () => {
    footer.remove()
    delete document.body.dataset.dshDesktopProductFooter
  }
}
