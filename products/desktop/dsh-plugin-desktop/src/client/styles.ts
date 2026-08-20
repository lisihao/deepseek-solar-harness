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
html, body { width: 100%; height: 100%; }
/* Keep the mount point's width automatic.  Workbench plugins such as
   dsh-better-sidebar reserve a fixed right panel with #root margin-right;
   forcing width:100% makes that margin overflow instead of shrinking the
   Desktop frame, so the panel covers the conversation and its controls. */
#root { width: auto; height: 100%; }
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
/* Memory Evolve renders save feedback before a long, internally scrolling
   form.  Keep the notice visible after the bottom action is clicked so a
   successful save cannot look like a no-op in the Desktop shell. */
body[data-dsh-desktop-mode="advanced"] .mt-panel .me-notice { position: sticky; top: 0; z-index: 2; }
/* Its value controls otherwise sit at the extreme right edge of every row,
   where fixed workbench affordances and pets can intercept the pointer.
   Use a compact label column so the actual controls stay in the unobscured
   conversation surface even when those optional plugins are visible. */
body[data-dsh-desktop-mode="advanced"] .mt-panel .me-form .me-field { justify-content: flex-start; }
body[data-dsh-desktop-mode="advanced"] .mt-panel .me-form .me-field-label { flex: 0 1 320px; }
@media (prefers-reduced-motion: reduce) { .dshDesktopFrame { transition: none !important; } }
`

/** Window-bottom product marker shared by compatibility and advanced shells. */
const SOLAR_BRAND_STYLES = `
:root { --dsh-desktop-popup-underlay: #fff; }
body[data-ds-dark-theme] { --dsh-desktop-popup-underlay: #151517; }
body[data-dsh-desktop-product-footer="true"] #root { height: calc(100% - 24px); }
.dshDesktopSolarFooter { position: fixed; z-index: 2147482000; right: 0; bottom: 0; left: 0; display: flex; align-items: center; justify-content: center; box-sizing: border-box; height: 24px; padding: 0 16px; overflow: hidden; border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 500; line-height: 23px; text-overflow: ellipsis; user-select: none; white-space: nowrap; -webkit-app-region: no-drag; }
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
.dshDesktopResidentPanel > header p, .dshDesktopResidentPanel > header small, .dshDesktopResidentEmpty { display: block; margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
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
.dshDesktopResidentSession strong, .dshDesktopResidentSession small, .dshDesktopResidentSession em { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopResidentSession small { color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopResidentSession em { color: var(--dsw-alias-label-secondary); font-size: 9px; font-style: normal; text-align: right; }
.dshDesktopResidentEvents ol { margin: 0; padding: 0; list-style: none; }
.dshDesktopResidentEvents li { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 3px 8px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 10px; }
.dshDesktopResidentEvents time { grid-row: 1 / 3; color: var(--dsw-alias-label-secondary); }
.dshDesktopResidentEvents li span { color: var(--dsw-alias-label-secondary); }
.dshDesktopResidentError { margin: 12px 24px 0; padding: 9px 12px; border: 1px solid color-mix(in srgb, #ff453a 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #ff453a 12%, transparent); color: #ff6961; font-size: 11px; }
.dshDesktopOrchestrationAction { display: grid; grid-template-columns: 9px minmax(0, 1fr); align-items: center; gap: 8px; box-sizing: border-box; width: calc(100% + 8px); margin: 2px -4px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dshDesktopOrchestrationAction > span:nth-child(2) { overflow: hidden; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopOrchestrationAction > span:nth-child(3) { grid-column: 2; color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopOrchestrationAction:not([data-wide]) { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin: 2px 0; padding: 0; border-radius: 50%; font-size: 9px; font-weight: 700; }
.dshDesktopOrchestrationAction:not([data-wide]) .dshDesktopOrchestrationDot { position: absolute; margin: -24px -25px 0 0; }
.dshDesktopOrchestrationDot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: #7d8799; box-shadow: 0 0 0 2px color-mix(in srgb, #7d8799 20%, transparent); }
.dshDesktopOrchestrationAction[data-status="running"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationRun[data-state="running"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationNodes > li[data-state="running"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationNodes > li[data-state="passed"] .dshDesktopOrchestrationDot { background: #34c759; box-shadow: 0 0 0 2px color-mix(in srgb, #34c759 20%, transparent); }
.dshDesktopOrchestrationAction[data-status="warn"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationRun[data-state="awaiting_approval"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationNodes > li[data-state="blocked"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationNodes > li[data-state="awaiting_recompile"] .dshDesktopOrchestrationDot { background: #f5a623; }
.dshDesktopOrchestrationAction[data-status="error"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationRun[data-state="failed"] .dshDesktopOrchestrationDot,
.dshDesktopOrchestrationNodes > li[data-state="failed"] .dshDesktopOrchestrationDot { background: #ff453a; }
.dshDesktopOrchestrationBackdrop { position: fixed; z-index: 2147483000; inset: 0; display: flex; align-items: center; justify-content: center; padding: 28px; background: rgb(5 8 14 / 60%); backdrop-filter: blur(8px); }
.dshDesktopOrchestrationPanel { box-sizing: border-box; width: min(1320px, calc(100vw - 56px)); height: min(820px, calc(100vh - 56px)); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 18px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 24px 80px rgb(0 0 0 / 45%); }
.dshDesktopOrchestrationPanel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 24px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.dshDesktopOrchestrationPanel h2, .dshDesktopOrchestrationPanel h3, .dshDesktopOrchestrationPanel p { margin: 0; }
.dshDesktopOrchestrationPanel h2 { font-size: 20px; line-height: 28px; }
.dshDesktopOrchestrationPanel h3 { margin-bottom: 8px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
.dshDesktopOrchestrationPanel > header p, .dshDesktopOrchestrationEmpty { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dshDesktopOrchestrationPanel > header > button { width: 32px; height: 32px; border: 0; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 22px; }
.dshDesktopOrchestrationGrid { display: grid; grid-template-columns: minmax(210px, .8fr) minmax(480px, 2fr) minmax(250px, 1fr); height: calc(100% - 82px); min-height: 0; }
.dshDesktopOrchestrationColumn { min-width: 0; overflow: auto; padding: 18px; border-right: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.dshDesktopOrchestrationColumn:last-child { border-right: 0; }
.dshDesktopOrchestrationRuns > small { display: block; margin: -4px 0 12px; color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopOrchestrationRun { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; margin-bottom: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dshDesktopOrchestrationRun[data-selected] { border-color: #4d6bfe; box-shadow: 0 0 0 1px color-mix(in srgb, #4d6bfe 40%, transparent); }
.dshDesktopOrchestrationRun strong, .dshDesktopOrchestrationRun small, .dshDesktopOrchestrationRun em { display: block; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDesktopOrchestrationRun small, .dshDesktopOrchestrationRun em { color: var(--dsw-alias-label-secondary); font-size: 9px; font-style: normal; }
.dshDesktopOrchestrationRun em { text-align: right; }
.dshDesktopOrchestrationRunHeader { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.dshDesktopOrchestrationRunHeader small { color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopCollaborationTrace { display: grid; gap: 4px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #4d6bfe 38%, var(--dsw-alias-border-l2)); border-left: 4px solid #4d6bfe; border-radius: 10px; background: color-mix(in srgb, #4d6bfe 7%, var(--dsw-alias-bg-layer-1)); font-size: 10px; line-height: 15px; }
.dshDesktopCollaborationTrace p { color: var(--dsw-alias-label-secondary); }
.dshDesktopCollaborationTrace strong { color: var(--dsw-alias-label-primary); font-size: 11px; }
.dshDesktopCollaborationTrace[data-policy="direct"] { border-color: color-mix(in srgb, #7d8799 40%, var(--dsw-alias-border-l2)); border-left-color: #7d8799; background: var(--dsw-alias-bg-layer-1); }
.dshDesktopCollaborationTrace[data-policy="codex"] { border-left-color: #34c759; }
.dshDesktopCollaborationTrace[data-policy="claude-code"] { border-left-color: #f5a623; }
.dshDesktopOrchestrationPipeline { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin-bottom: 14px; }
.dshDesktopOrchestrationPipeline span { position: relative; padding: 6px 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font-size: 8px; text-align: center; }
.dshDesktopOrchestrationPipeline span[data-complete] { border-color: color-mix(in srgb, #34c759 38%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-label-primary); }
.dshDesktopOrchestrationPipeline span[data-complete]::before { margin-right: 3px; color: #34c759; content: "✓"; }
.dshDesktopOrchestrationNodes { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.dshDesktopOrchestrationNodes > li { padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshDesktopOrchestrationNodeTitle { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; }
.dshDesktopOrchestrationNodeTitle strong, .dshDesktopOrchestrationNodeTitle small { display: block; }
.dshDesktopOrchestrationNodeTitle small, .dshDesktopOrchestrationNodeTitle em { color: var(--dsw-alias-label-secondary); font-size: 9px; font-style: normal; }
.dshDesktopOrchestrationDependencies { margin: 9px 0 7px 17px; color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dshDesktopOrchestrationMeta, .dshDesktopOrchestrationRefs { display: flex; flex-wrap: wrap; gap: 5px; margin-left: 17px; }
.dshDesktopOrchestrationMeta span, .dshDesktopOrchestrationRefs span { padding: 4px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 8px; }
.dshDesktopOrchestrationRefs { margin-top: 6px; }
.dshDesktopOrchestrationRefs span[data-ready] { color: var(--dsw-alias-label-primary); }
.dshDesktopOrchestrationBlockers { display: grid; gap: 5px; margin: 9px 0 0; padding: 0; list-style: none; }
.dshDesktopOrchestrationBlockers li { display: grid; gap: 2px; padding: 7px 8px; border: 1px solid color-mix(in srgb, #f5a623 35%, transparent); border-radius: 7px; background: color-mix(in srgb, #f5a623 9%, var(--dsw-alias-bg-base)); font-size: 9px; }
.dshDesktopOrchestrationBlockers span { color: var(--dsw-alias-label-secondary); }
.dshDesktopOrchestrationControls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.dshDesktopOrchestrationNodes .dshDesktopOrchestrationControls { margin-top: 9px; }
.dshDesktopOrchestrationControls button { padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 9px; }
.dshDesktopOrchestrationControls button:disabled { cursor: default; opacity: .5; }
.dshDesktopOrchestrationEvents ol { margin: 0; padding: 0; list-style: none; }
.dshDesktopOrchestrationEvents li { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 3px 7px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 9px; }
.dshDesktopOrchestrationEvents time { grid-row: 1 / 3; color: var(--dsw-alias-label-secondary); }
.dshDesktopOrchestrationEvents li span { color: var(--dsw-alias-label-secondary); }
.dshDesktopOrchestrationEvents li small { grid-column: 2; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dshDesktopOrchestrationError { margin: 12px 24px 0; padding: 9px 12px; border: 1px solid color-mix(in srgb, #ff453a 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #ff453a 12%, var(--dsw-alias-bg-base)); color: #ff6961; font-size: 11px; }
.dshDesktopOperatorRoutingWrap { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dshDesktopOperatorRoutingChip { display: inline-flex; align-items: center; gap: 2px; max-width: 132px; height: 26px; padding: 0 5px 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; white-space: nowrap; }
.dshDesktopOperatorRoutingChip:hover:not(:disabled), .dshDesktopOperatorRoutingChip[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshDesktopOperatorRoutingChip:disabled { cursor: default; opacity: .48; }
.dshDesktopOperatorRoutingChip > span { overflow: hidden; text-overflow: ellipsis; }
.dshDesktopOperatorStrategyBackdrop { position: fixed; z-index: 2147482990; inset: 0; background: transparent; }
.dshDesktopOperatorStrategyPanel { position: fixed; box-sizing: border-box; width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 72px); overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: linear-gradient(var(--dsw-alias-bg-base, transparent), var(--dsw-alias-bg-base, transparent)), var(--dsh-desktop-popup-underlay); color: var(--dsw-alias-label-primary); box-shadow: 0 18px 54px rgb(0 0 0 / 38%); }
.dshDesktopOperatorStrategyPanel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 16px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopOperatorStrategyPanel > header div, .dshDesktopOperatorProfilePreferences > div { display: grid; gap: 3px; }
.dshDesktopOperatorStrategyPanel strong { font-size: 12px; }
.dshDesktopOperatorStrategyPanel small, .dshDesktopOperatorStrategyPanel p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 15px; }
.dshDesktopOperatorStrategyPanel > header > button { flex: none; width: 26px; height: 26px; border: 0; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 18px; }
.dshDesktopOperatorStrategyOptions { display: grid; gap: 5px; padding: 10px; }
.dshDesktopOperatorStrategyOptions > button { display: grid; grid-template-columns: 14px minmax(0, 1fr); align-items: start; gap: 9px; width: 100%; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dshDesktopOperatorStrategyOptions > button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dshDesktopOperatorStrategyOptions > button[data-selected] { border-color: color-mix(in srgb, #f5a623 55%, transparent); background: color-mix(in srgb, #f5a623 10%, transparent); }
.dshDesktopOperatorStrategyOptions > button:disabled { cursor: default; opacity: .58; }
.dshDesktopOperatorStrategyOptions > button > span:last-child { display: grid; gap: 2px; }
.dshDesktopOperatorStrategyRadio { box-sizing: border-box; width: 12px; height: 12px; margin-top: 2px; border: 1px solid var(--dsw-alias-label-tertiary); border-radius: 50%; }
.dshDesktopOperatorStrategyOptions > button[data-selected] .dshDesktopOperatorStrategyRadio { border: 3px solid #f5a623; }
.dshDesktopOperatorProfilePreferences { display: grid; gap: 10px; margin: 0 10px 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dshDesktopOperatorProfilePreferences label { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 1.1fr); align-items: center; gap: 12px; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.dshDesktopOperatorProfilePreferences select { min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 10px; }
.dshDesktopOperatorStrategyError { margin: 0 12px 12px !important; padding: 7px 9px; border-radius: 7px; background: color-mix(in srgb, #ff453a 12%, transparent); color: #ff6961 !important; }
@media (max-width: 900px) { .dshDesktopResidentGrid { grid-template-columns: 1fr; overflow: auto; } .dshDesktopResidentColumn { overflow: visible; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); } }
@media (max-width: 1080px) { .dshDesktopOrchestrationGrid { grid-template-columns: 220px minmax(0, 1fr); overflow: auto; } .dshDesktopOrchestrationEvents { grid-column: 1 / -1; border-top: 1px solid var(--dsw-alias-border-l2); } }
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
