/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

/** Complete accessible product marker with the running package version. */
export function solarBrandLabel(productVersion: string): string {
  return `DSH Desktop v${productVersion} · ${SOLAR_BRAND}`
}

/** Mount the persistent one-line product marker below the complete application surface. */
export function mountSolarBrandFooter(productVersion: string): () => void {
  const label = solarBrandLabel(productVersion)
  const footer = document.createElement('footer')
  footer.className = 'dshDesktopSolarFooter'
  footer.dataset.testid = 'solar-desktop-brand'
  footer.setAttribute('role', 'note')
  footer.setAttribute('aria-label', label)
  footer.title = label
  footer.textContent = label

  document.body.dataset.dshDesktopProductFooter = 'true'
  document.body.appendChild(footer)

  return () => {
    footer.remove()
    delete document.body.dataset.dshDesktopProductFooter
  }
}
