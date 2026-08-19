/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

/** Complete accessible product marker with the running package version. */
export function solarBrandLabel(productVersion: string): string {
  return `DSH Desktop v${productVersion} · ${SOLAR_BRAND}`
}

/** Mount the persistent, non-interactive product marker below the application content. @returns the marker disposer. */
export function installSolarBrand(productVersion: string): () => void {
  const label = solarBrandLabel(productVersion)
  const marker = document.createElement('div')
  marker.className = 'dshDesktopSolarBrand'
  marker.dataset.testid = 'solar-desktop-brand'
  marker.setAttribute('role', 'note')
  marker.setAttribute('aria-label', label)
  marker.title = label
  marker.textContent = label
  document.body.dataset.dshDesktopBrandBar = ''
  document.body.appendChild(marker)
  return () => {
    marker.remove()
    delete document.body.dataset.dshDesktopBrandBar
  }
}
