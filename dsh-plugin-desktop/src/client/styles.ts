import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../window-chrome.ts'
import { SIDEBAR_COLLAPSED } from './layout-state.ts'

/** Advanced-shell stylesheet kept as a plain string so the package client bundle stays self-contained. */
const ADVANCED_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshDesktopUpstreamSidebar { box-sizing: border-box; width: 100%; height: 100%; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopUpstreamSidebar { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-platform="darwin"] { grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface { grid-row: 1 / -1; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopMacCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopMacCaptionRow::before { content: ""; position: absolute; top: 0; right: 0; left: 0; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopDetailsSurface { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-desktop-platform="win32"] { grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-sidebar-collapsed] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopMacCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface::before { -webkit-app-region: no-drag !important; }
@media (prefers-reduced-motion: reduce) { .dshDesktopFrame { transition: none !important; } }
`

/** Root-scoped product marker shared by compatibility and advanced shells. */
const SOLAR_BRAND_STYLES = `
.dshDesktopSolarBrand { position: relative; flex: none; box-sizing: border-box; width: calc(100% + 8px); margin: 4px -4px 6px; padding: 8px 10px 8px 12px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: linear-gradient(135deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary); }
.dshDesktopSolarBrand::before { position: absolute; inset: 7px auto 7px 0; width: 3px; border-radius: 0 3px 3px 0; background: #f5a623; content: ""; }
.dshDesktopSolarBrandPrimary, .dshDesktopSolarBrandTagline { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopSolarBrandPrimary { font-size: 11px; font-weight: 600; line-height: 16px; }
.dshDesktopSolarBrandTagline { color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 15px; }
.dshDesktopSolarBrand:not([data-wide]) { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin: 2px 0; padding: 0; border-radius: 50%; }
.dshDesktopSolarBrand:not([data-wide])::before { display: none; }
.dshDesktopSolarBrandRail { color: #f5a623; font-size: 8px; font-weight: 700; letter-spacing: -0.2px; white-space: nowrap; }
.dshDesktopResidentAction { display: grid; grid-template-columns: 9px minmax(0, 1fr); align-items: center; gap: 8px; box-sizing: border-box; width: calc(100% + 8px); margin: 2px -4px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dshDesktopResidentAction > span:nth-child(2) { overflow: hidden; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopResidentAction > span:nth-child(3) { grid-column: 2; color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopResidentAction:not([data-wide]) { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin: 2px 0; padding: 0; border-radius: 50%; font-size: 9px; font-weight: 700; }
.dshDesktopResidentAction:not([data-wide]) .dshDesktopResidentDot { position: absolute; margin: -24px -25px 0 0; }
.dshDesktopResidentDot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: #7d8799; box-shadow: 0 0 0 2px color-mix(in srgb, #7d8799 20%, transparent); }
.dshDesktopResidentAction[data-status="running"] .dshDesktopResidentDot, .dshDesktopResidentSession[data-health="ok"] .dshDesktopResidentDot, .dshDesktopResidentProvider[data-ok] .dshDesktopResidentDot { background: #34c759; box-shadow: 0 0 0 2px color-mix(in srgb, #34c759 20%, transparent); }
.dshDesktopResidentAction[data-status="warn"] .dshDesktopResidentDot, .dshDesktopResidentSession[data-health="degraded"] .dshDesktopResidentDot { background: #f5a623; }
.dshDesktopResidentAction[data-status="error"] .dshDesktopResidentDot, .dshDesktopResidentSession[data-health="unavailable"] .dshDesktopResidentDot { background: #ff453a; }
.dshDesktopResidentBackdrop { position: fixed; z-index: 2147483000; inset: 0; display: flex; align-items: center; justify-content: center; padding: 32px; background: rgb(5 8 14 / 58%); backdrop-filter: blur(8px); }
.dshDesktopResidentPanel { box-sizing: border-box; width: min(1120px, calc(100vw - 64px)); height: min(720px, calc(100vh - 64px)); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 18px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 24px 80px rgb(0 0 0 / 45%); }
.dshDesktopResidentPanel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 24px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopResidentPanel h2, .dshDesktopResidentPanel h3, .dshDesktopResidentPanel p { margin: 0; }
.dshDesktopResidentPanel h2 { font-size: 20px; line-height: 28px; }
.dshDesktopResidentPanel h3 { margin-bottom: 10px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
.dshDesktopResidentPanel > header p, .dshDesktopResidentEmpty { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshDesktopResidentPanel > header > button { width: 32px; height: 32px; border: 0; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 22px; }
.dshDesktopResidentGrid { display: grid; grid-template-columns: 1.05fr 1.25fr 1fr; height: calc(100% - 82px); min-height: 0; }
.dshDesktopResidentColumn { min-width: 0; overflow: auto; padding: 18px; border-right: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopResidentColumn:last-child { border-right: 0; }
.dshDesktopResidentProviders { display: grid; gap: 8px; margin-bottom: 22px; }
.dshDesktopResidentProvider { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dshDesktopResidentProvider strong, .dshDesktopResidentProvider small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopResidentProvider small { color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopResidentProvider em { color: var(--dsw-alias-label-secondary); font-size: 9px; font-style: normal; }
.dshDesktopResidentHelp { display: grid; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.dshDesktopResidentHelp code { display: block; padding: 8px 10px; overflow-wrap: anywhere; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 10px; }
.dshDesktopResidentSession { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; margin-bottom: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dshDesktopResidentSession[data-selected] { border-color: #f5a623; box-shadow: 0 0 0 1px color-mix(in srgb, #f5a623 40%, transparent); }
.dshDesktopResidentSession strong, .dshDesktopResidentSession small, .dshDesktopResidentSession em { display: block; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopResidentSession small { color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopResidentSession em { color: var(--dsw-alias-label-secondary); font-size: 9px; font-style: normal; text-align: right; }
.dshDesktopResidentEvents ol { margin: 0; padding: 0; list-style: none; }
.dshDesktopResidentEvents li { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 3px 8px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 10px; }
.dshDesktopResidentEvents time { grid-row: 1 / 3; color: var(--dsw-alias-label-secondary); }
.dshDesktopResidentEvents li span { color: var(--dsw-alias-label-secondary); }
.dshDesktopResidentError { margin: 12px 24px 0; padding: 9px 12px; border: 1px solid color-mix(in srgb, #ff453a 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #ff453a 12%, transparent); color: #ff6961; font-size: 11px; }
.dshDesktopOperatorRoutingWrap { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dshDesktopOperatorRoutingChip { display: inline-flex; align-items: center; gap: 2px; max-width: 148px; height: 26px; padding: 0 5px 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; white-space: nowrap; }
.dshDesktopOperatorRoutingChip:hover:not(:disabled), .dshDesktopOperatorRoutingChip[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshDesktopOperatorRoutingChip:disabled { cursor: default; opacity: .48; }
.dshDesktopOperatorRoutingChip > span { overflow: hidden; text-overflow: ellipsis; }
.dshDesktopOperatorRoutingItem { display: grid; max-width: 270px; gap: 2px; }
.dshDesktopOperatorRoutingItem strong { font-size: 11px; font-weight: 600; }
.dshDesktopOperatorRoutingItem small { color: var(--dsw-alias-label-secondary); font-size: 9px; line-height: 13px; white-space: normal; }
.dshDesktopOperatorRoutingError { position: absolute; right: 0; bottom: 100%; margin-bottom: 4px; padding: 3px 5px; border-radius: 5px; background: #ff453a; color: white; font-size: 9px; white-space: nowrap; }
@media (max-width: 900px) { .dshDesktopResidentGrid { grid-template-columns: 1fr; overflow: auto; } .dshDesktopResidentColumn { overflow: visible; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); } }
`

/** Install and remove the advanced shell's global native-window styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/advanced-shell'
  style.textContent = ADVANCED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Install the always-visible Solar product marker styles. @returns the style disposer. */
export function installSolarBrandStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/solar-brand'
  style.textContent = SOLAR_BRAND_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
