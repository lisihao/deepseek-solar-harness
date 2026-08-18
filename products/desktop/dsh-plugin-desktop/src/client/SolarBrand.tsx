import type { DesktopSidebarFooterActionOwnerProps } from './contracts.ts'

/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

export type SolarBrandProps = DesktopSidebarFooterActionOwnerProps & {
  /** Product version supplied by the packaged Electron Host. */
  productVersion: string
}

/** Complete accessible product marker with the running package version. */
export function solarBrandLabel(productVersion: string): string {
  return `DSH Desktop v${productVersion} · ${SOLAR_BRAND}`
}

/** Persistent Solar product marker in the root-scoped sidebar footer. */
export function SolarBrand({ productVersion, wide }: SolarBrandProps) {
  const label = solarBrandLabel(productVersion)
  return (
    <div
      className="dshDesktopSolarBrand"
      data-wide={wide || undefined}
      data-testid="solar-desktop-brand"
      role="note"
      aria-label={label}
      title={label}
    >
      {wide
        ? <><span className="dshDesktopSolarBrandPrimary">DSH Desktop v{productVersion}</span><span className="dshDesktopSolarBrandTagline">{SOLAR_BRAND}</span></>
        : <span className="dshDesktopSolarBrandRail">v{productVersion}</span>}
    </div>
  )
}
