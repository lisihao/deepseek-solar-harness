const ORCHESTRATION_STYLES = `
.dshDesktopOrchestrationAction { display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:10px;font-weight:600;white-space:nowrap }
.dshDesktopOrchestrationAction:hover { background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary) }
.dshDesktopOrchestrationDot { display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:#7d8799;box-shadow:0 0 0 2px color-mix(in srgb,#7d8799 20%,transparent) }
.dshDesktopOrchestrationAction[data-status="running"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationRun[data-state="running"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationNodes>li[data-state="running"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationNodes>li[data-state="passed"] .dshDesktopOrchestrationDot { background:#34c759;box-shadow:0 0 0 2px color-mix(in srgb,#34c759 20%,transparent) }
.dshDesktopOrchestrationAction[data-status="warn"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationRun[data-state="awaiting_approval"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationNodes>li[data-state="blocked"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationNodes>li[data-state="awaiting_recompile"] .dshDesktopOrchestrationDot { background:#f5a623 }
.dshDesktopOrchestrationAction[data-status="error"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationRun[data-state="failed"] .dshDesktopOrchestrationDot,.dshDesktopOrchestrationNodes>li[data-state="failed"] .dshDesktopOrchestrationDot { background:#ff453a }
.dshDesktopOrchestrationBackdrop { position:fixed;z-index:2147483000;inset:0;display:flex;align-items:center;justify-content:center;padding:28px;background:rgb(5 8 14/60%);backdrop-filter:blur(8px) }
.dshDesktopOrchestrationPanel { box-sizing:border-box;width:min(1320px,calc(100vw - 56px));height:min(820px,calc(100vh - 56px));overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:18px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 24px 80px rgb(0 0 0/45%) }
.dshDesktopOrchestrationPanel>header { display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:20px 24px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base) }
.dshDesktopOrchestrationPanel h2,.dshDesktopOrchestrationPanel h3,.dshDesktopOrchestrationPanel p { margin:0 }
.dshDesktopOrchestrationPanel h2 { font-size:20px;line-height:28px }
.dshDesktopOrchestrationPanel h3 { margin-bottom:8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase }
.dshDesktopOrchestrationPanel>header p,.dshDesktopOrchestrationEmpty { margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px }
.dshDesktopOrchestrationPanel>header>button { width:32px;height:32px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:22px }
.dshDesktopOrchestrationGrid { display:grid;grid-template-columns:minmax(210px,.8fr) minmax(480px,2fr) minmax(250px,1fr);height:calc(100% - 82px);min-height:0 }
.dshDesktopOrchestrationColumn { min-width:0;overflow:auto;padding:18px;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base) }
.dshDesktopOrchestrationColumn:last-child { border-right:0 }
.dshDesktopOrchestrationRuns>small { display:block;margin:-4px 0 12px;color:var(--dsw-alias-label-secondary);font-size:9px }
.dshDesktopOrchestrationDiagnosticToggle { width:100%;margin:0 0 10px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:10px }
.dshDesktopOrchestrationDiagnosticBadge { display:inline-block;margin-left:6px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:500;vertical-align:1px }
.dshDesktopOrchestrationRun { display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;margin-bottom:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left }
.dshDesktopOrchestrationRun[data-selected] { border-color:#4d6bfe;box-shadow:0 0 0 1px color-mix(in srgb,#4d6bfe 40%,transparent) }
.dshDesktopOrchestrationRun strong,.dshDesktopOrchestrationRun small,.dshDesktopOrchestrationRun em { display:block;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.dshDesktopOrchestrationRun small,.dshDesktopOrchestrationRun em,.dshDesktopOrchestrationRunHeader small { color:var(--dsw-alias-label-secondary);font-size:9px;font-style:normal }
.dshDesktopOrchestrationRun em { text-align:right }
.dshDesktopOrchestrationRunHeader { display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px }
.dshDesktopCollaborationTrace { display:grid;gap:4px;margin-bottom:14px;padding:10px 12px;border:1px solid color-mix(in srgb,#4d6bfe 38%,var(--dsw-alias-border-l2));border-left:4px solid #4d6bfe;border-radius:10px;background:color-mix(in srgb,#4d6bfe 7%,var(--dsw-alias-bg-layer-1));font-size:10px;line-height:15px }
.dshDesktopCollaborationTrace p { color:var(--dsw-alias-label-secondary) }.dshDesktopCollaborationTrace strong { color:var(--dsw-alias-label-primary);font-size:11px }.dshDesktopCollaborationTrace[data-policy="direct"] { border-left-color:#7d8799 }.dshDesktopCollaborationTrace[data-policy="codex"] { border-left-color:#34c759 }.dshDesktopCollaborationTrace[data-policy="claude-code"] { border-left-color:#f5a623 }
.dshDesktopOrchestrationPipeline { display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:4px;margin-bottom:14px }
.dshDesktopOrchestrationPipeline span { padding:6px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:8px;text-align:center }.dshDesktopOrchestrationPipeline span[data-complete] { color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,#34c759 38%,var(--dsw-alias-border-l2)) }.dshDesktopOrchestrationPipeline span[data-complete]::before { margin-right:3px;color:#34c759;content:"✓" }
.dshDesktopOrchestrationNodes { display:grid;gap:10px;margin:0;padding:0;list-style:none }.dshDesktopOrchestrationNodes>li { padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1) }
.dshDesktopOrchestrationNodeTitle { display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:9px }.dshDesktopOrchestrationNodeTitle strong,.dshDesktopOrchestrationNodeTitle small { display:block }.dshDesktopOrchestrationNodeTitle small,.dshDesktopOrchestrationNodeTitle em { color:var(--dsw-alias-label-secondary);font-size:9px;font-style:normal }
.dshDesktopOrchestrationDependencies { margin:9px 0 7px 17px;color:var(--dsw-alias-label-secondary);font-size:9px }.dshDesktopOrchestrationMeta,.dshDesktopOrchestrationRefs { display:flex;flex-wrap:wrap;gap:5px;margin-left:17px }.dshDesktopOrchestrationMeta span,.dshDesktopOrchestrationRefs span { padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:8px }.dshDesktopOrchestrationRefs { margin-top:6px }.dshDesktopOrchestrationRefs span[data-ready] { color:var(--dsw-alias-label-primary) }
.dshDesktopOrchestrationBlockers { display:grid;gap:5px;margin:9px 0 0;padding:0;list-style:none }.dshDesktopOrchestrationBlockers li { display:grid;gap:2px;padding:7px 8px;border:1px solid color-mix(in srgb,#f5a623 35%,transparent);border-radius:7px;background:color-mix(in srgb,#f5a623 9%,var(--dsw-alias-bg-base));font-size:9px }.dshDesktopOrchestrationBlockers span { color:var(--dsw-alias-label-secondary) }
.dshDesktopOrchestrationControls { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px }.dshDesktopOrchestrationNodes .dshDesktopOrchestrationControls { margin-top:9px }.dshDesktopOrchestrationControls button { padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:9px }.dshDesktopOrchestrationControls button:disabled { cursor:default;opacity:.5 }
.dshDesktopOrchestrationEvents ol { margin:0;padding:0;list-style:none }.dshDesktopOrchestrationEvents li { display:grid;grid-template-columns:68px minmax(0,1fr);gap:3px 7px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:9px }.dshDesktopOrchestrationEvents time { grid-row:1/3;color:var(--dsw-alias-label-secondary) }.dshDesktopOrchestrationEvents li span { color:var(--dsw-alias-label-secondary) }.dshDesktopOrchestrationEvents li small { grid-column:2;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;white-space:pre-wrap }
.dshDesktopOrchestrationError { margin:12px 24px 0;padding:9px 12px;border:1px solid color-mix(in srgb,#ff453a 45%,transparent);border-radius:8px;background:color-mix(in srgb,#ff453a 12%,var(--dsw-alias-bg-base));color:#ff6961;font-size:11px }
@media(max-width:1080px){.dshDesktopOrchestrationGrid{grid-template-columns:220px minmax(0,1fr);overflow:auto}.dshDesktopOrchestrationEvents{grid-column:1/-1;border-top:1px solid var(--dsw-alias-border-l2)}}
@media(max-width:720px){.dshDesktopOrchestrationBackdrop{padding:8px}.dshDesktopOrchestrationPanel{width:calc(100vw - 16px);height:calc(100vh - 16px)}.dshDesktopOrchestrationGrid{display:block;overflow:auto;height:calc(100% - 82px)}.dshDesktopOrchestrationColumn{overflow:visible;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}}
`

/**
 * Install styles owned by the orchestration client plugin.
 * @returns a disposer that removes the installed style element.
 */
export function installOrchestrationStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = '@deepseek-ai/dsh-ui-orchestration'
  style.textContent = ORCHESTRATION_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
