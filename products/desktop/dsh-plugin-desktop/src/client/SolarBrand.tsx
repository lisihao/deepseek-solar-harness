import type { DesktopClientEnvironment } from './environment.ts'
import { CONFIGURE_DEPLOYMENT_URL, USE_LOCAL_SERVER_URL } from '../deployment-links.ts'

export { CONFIGURE_DEPLOYMENT_URL, USE_LOCAL_SERVER_URL } from '../deployment-links.ts'

/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

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
  const configure = document.createElement('button')
  configure.type = 'button'
  configure.className = 'dshDesktopUseLocalServer'
  configure.dataset.testid = 'desktop-configure-deployment'
  configure.textContent = environment.deploymentRole === 'frontend'
    ? '部署 / 同步'
    : '连接远程 Server'
  configure.title = environment.deploymentRole === 'frontend'
    ? '切换本机 Server 或远程 Frontend，配置多个 Server、Git 与闭合 Session 同步'
    : '配置一个或多个远程 DSH Server，或保留本机 Server 模式'
  configure.addEventListener('click', () => { window.location.assign(CONFIGURE_DEPLOYMENT_URL) })
  footer.appendChild(configure)
  if (environment.deploymentRole === 'frontend') {
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
