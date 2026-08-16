import type { DesktopSidebarFooterActionOwnerProps } from './contracts.ts'

/** Product position shown inside the DSH Desktop interface. */
export const SOLAR_BRAND = 'DSH - DeepSeek Harness的Solar分支，目标是您的All-in-One AI工作台'

export type SolarBrandProps = DesktopSidebarFooterActionOwnerProps

/** Persistent Solar product marker in the root-scoped sidebar footer. */
export function SolarBrand({ wide }: SolarBrandProps) {
  return (
    <div
      className="dshDesktopSolarBrand"
      data-wide={wide || undefined}
      data-testid="solar-desktop-brand"
      role="note"
      aria-label={SOLAR_BRAND}
      title={SOLAR_BRAND}
    >
      {wide
        ? <><span className="dshDesktopSolarBrandPrimary">DSH - DeepSeek Harness的Solar分支，</span><span className="dshDesktopSolarBrandTagline">目标是您的All-in-One AI工作台</span></>
        : <span className="dshDesktopSolarBrandRail" aria-hidden="true">S</span>}
    </div>
  )
}
