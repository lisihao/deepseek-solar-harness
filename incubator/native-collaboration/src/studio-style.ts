import { createElement, type ReactElement } from 'react'
import flowCss from '@xyflow/react/dist/style.css'

const flowDashdrawKeyframes = /@keyframes dashdraw\s*\{\s*from\s*\{\s*stroke-dashoffset:\s*10;\s*\}\s*\}/u
const scopedFlowCss = flowCss
  // XYFlow's only global rule is its named animation. Keep it global but unique;
  // all selector rules below are deliberately nested under the panel container.
  .replace(flowDashdrawKeyframes, '')
  .replaceAll('dashdraw', 'solar-workflow-studio-dashdraw')

/** The host browser bundle loads the library stylesheet as text, so this panel remains self-contained. */
export const workflowStudioCss = `
.solar-workflow-studio {
${scopedFlowCss}
}

@keyframes solar-workflow-studio-dashdraw {
  from { stroke-dashoffset: 10; }
}

.solar-workflow-studio {
  --solar-studio-border: var(--dsw-alias-settings-card-stroke, rgba(145, 150, 166, .28));
  --solar-studio-border-subtle: color-mix(in srgb, var(--solar-studio-border) 64%, transparent);
  --solar-studio-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-module-platform, #20242b));
  --solar-studio-surface: var(--dsw-alias-bg-base, #15171b);
  --solar-studio-control: var(--dsw-alias-bg-module-platform, var(--solar-studio-card));
  --solar-studio-text: var(--dsw-alias-label-primary, #f3f4f6);
  --solar-studio-muted: var(--dsw-alias-label-secondary, #a0a6b2);
  --solar-studio-accent: var(--dsw-alias-brand-primary, #ba7dff);
  --solar-studio-primary-fill: color-mix(in srgb, var(--solar-studio-accent) 70%, #20122f);
  --solar-studio-accent-soft: color-mix(in srgb, var(--solar-studio-accent) 14%, transparent);
  --solar-studio-success: var(--dsw-alias-state-success-primary, #83c7a6);
  --solar-studio-warning: var(--dsw-alias-state-warning-primary, #d6ad72);
  --solar-studio-error: var(--dsw-alias-state-error-primary, #e87070);
  color: var(--solar-studio-text);
  display: grid;
  gap: 10px;
  font-size: 14px;
  line-height: 1.45;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  background: transparent;
  container-type: inline-size;
  container-name: workflow-studio;
}

.solar-workflow-studio h1,
.solar-workflow-studio h2,
.solar-workflow-studio h3,
.solar-workflow-studio p,
.solar-workflow-studio pre,
.solar-workflow-studio ul { margin: 0; }

.solar-workflow-studio__panel,
.solar-workflow-studio__inspector,
.solar-workflow-studio__flow-picker,
.solar-workflow-studio__run-list,
.solar-workflow-studio__draft-summary,
.solar-workflow-studio__empty-state {
  min-width: 0;
  border: 1px solid var(--solar-studio-border-subtle);
  border-radius: 8px;
  background: var(--solar-studio-card);
}

.solar-workflow-studio__intro { padding: 2px 2px 0; display: grid; gap: 2px; }
.solar-workflow-studio__intro h1,
.solar-workflow-studio__intro h2,
.solar-workflow-studio__draft-summary h2,
.solar-workflow-studio__inspector h2,
.solar-workflow-studio__panel h2,
.solar-workflow-studio__empty-state h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; letter-spacing: .01em; }
.solar-workflow-studio__intro h1 { font-size: 16px; line-height: 22px; font-weight: 620; }
.solar-workflow-studio__intro p,
.solar-workflow-studio__panel p,
.solar-workflow-studio__inspector p,
.solar-workflow-studio__draft-summary p,
.solar-workflow-studio__empty-state p { margin: 0; }
.solar-workflow-studio__muted { color: var(--solar-studio-muted); font-size: 13px; overflow-wrap: anywhere; }
.solar-workflow-studio__error { color: var(--solar-studio-error); font-size: 13px; overflow-wrap: anywhere; }
.solar-workflow-studio__success { color: var(--solar-studio-success); font-size: 13px; overflow-wrap: anywhere; }
.solar-workflow-studio__quota-warning { color: var(--solar-studio-warning); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }

.solar-workflow-studio__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  padding: 0;
}
.solar-workflow-studio__toolbar-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
}
.solar-workflow-studio__execution-action { flex: 1 1 18rem; }
.solar-workflow-studio__execution-action > span { min-width: 11rem; flex: 1 1 11rem; }
.solar-workflow-studio__draft-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 6px 16px;
  padding: 9px 10px;
}
.solar-workflow-studio__draft-summary > div { display: grid; gap: 3px; min-width: 0; }
.solar-workflow-studio__draft-status { font-size: 12px; }
.solar-workflow-studio__draft-status[data-state="saved"] { color: var(--solar-studio-muted); }
.solar-workflow-studio__draft-status[data-state="unsaved"] { color: var(--solar-studio-warning); }
.solar-workflow-studio__empty-state {
  display: grid;
  gap: 6px;
  max-width: 44rem;
  padding: 14px 12px;
  border-left-color: var(--solar-studio-border-subtle);
}

.solar-workflow-studio button,
.solar-workflow-studio input,
.solar-workflow-studio select,
.solar-workflow-studio textarea {
  font: inherit;
}

.solar-workflow-studio button {
  min-height: 30px;
  max-width: 100%;
  margin: 0;
  padding: 5px 9px;
  border: 1px solid var(--solar-studio-border-subtle);
  border-radius: 7px;
  background: var(--solar-studio-control);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.solar-workflow-studio button:hover:not(:disabled) { border-color: var(--solar-studio-accent); }
.solar-workflow-studio button:focus-visible { outline: 2px solid var(--solar-studio-accent); outline-offset: 2px; }
.solar-workflow-studio button:disabled { cursor: not-allowed; opacity: .48; }
.solar-workflow-studio button[data-variant="primary"] { border-color: var(--solar-studio-border-subtle); }
.solar-workflow-studio__toolbar-group[aria-label="保存草稿"] button[data-variant="primary"] {
  border-color: transparent;
  background: var(--solar-studio-primary-fill);
  color: #fff;
}
.solar-workflow-studio__toolbar-group[aria-label="保存草稿"] button[data-variant="primary"]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--solar-studio-primary-fill) 88%, black);
}
.solar-workflow-studio button[data-variant="danger"] { border-color: var(--solar-studio-border-subtle); color: var(--solar-studio-muted); }
.solar-workflow-studio button[data-variant="danger"]:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--solar-studio-error) 58%, transparent);
  background: color-mix(in srgb, var(--solar-studio-error) 9%, var(--solar-studio-control));
  color: var(--solar-studio-error);
}
.solar-workflow-studio button[data-variant="danger"]:focus-visible { outline-color: var(--solar-studio-error); }

.solar-workflow-studio__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 304px);
  gap: 8px;
  min-width: 0;
}

.solar-workflow-studio__canvas-column { display: grid; gap: 8px; min-width: 0; }
.solar-workflow-studio__canvas {
  min-height: 420px;
  border: 1px solid var(--solar-studio-border-subtle);
  border-radius: 8px;
  overflow: hidden;
  background-color: var(--solar-studio-card);
  background-image: radial-gradient(var(--solar-studio-border-subtle) .75px, transparent .75px);
  background-size: 20px 20px;
}

.solar-workflow-studio .react-flow { background: transparent; }
.solar-workflow-studio .react-flow__controls { box-shadow: none; border: 1px solid var(--solar-studio-border-subtle); border-radius: 7px; overflow: hidden; }
.solar-workflow-studio .react-flow__controls-button {
  background: var(--solar-studio-control);
  background-image: none;
  color: var(--solar-studio-text);
  fill: currentColor;
  border-bottom-color: var(--solar-studio-border-subtle);
}
.solar-workflow-studio .react-flow__controls-fitview { background: var(--solar-studio-control); color: var(--solar-studio-text); }
.solar-workflow-studio .react-flow__controls-button:hover,
.solar-workflow-studio .react-flow__controls-button:focus-visible {
  background: var(--solar-studio-control);
  color: var(--solar-studio-text);
  fill: currentColor;
}
.solar-workflow-studio .react-flow__controls-button svg,
.solar-workflow-studio .react-flow__controls-button svg path { fill: currentColor; }
.solar-workflow-studio .react-flow__edge-path { stroke: var(--solar-studio-muted); stroke-width: 1.25; }
.solar-workflow-studio .react-flow__handle { width: 7px; height: 7px; background: var(--solar-studio-accent); border-color: var(--solar-studio-card); }
.solar-workflow-studio .react-flow__node { border-radius: 7px; }

.solar-workflow-studio__stage {
  min-width: 150px;
  max-width: 220px;
  display: grid;
  gap: 3px;
  padding: 8px 9px;
  border: 1px solid var(--solar-studio-border-subtle);
  border-radius: 7px;
  color: var(--solar-studio-text);
  background: var(--solar-studio-control);
  box-shadow: none;
}

.solar-workflow-studio__stage[data-status="running"],
.solar-workflow-studio__stage[data-status="pending"] { border-left: 2px solid var(--solar-studio-accent); }
.solar-workflow-studio__stage[data-status="failed"],
.solar-workflow-studio__stage[data-status="unknown"] { border-left: 2px solid var(--solar-studio-warning); }
.solar-workflow-studio__stage-title { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.solar-workflow-studio__stage-kind { color: var(--solar-studio-muted); font-size: 12px; overflow-wrap: anywhere; }

.solar-workflow-studio__inspector,
.solar-workflow-studio__panel,
.solar-workflow-studio__run-list { padding: 9px 10px; display: grid; align-content: start; gap: 7px; }
.solar-workflow-studio__inspector { min-height: 0; align-self: start; }
.solar-workflow-studio__flow-picker { min-width: 0; }
.solar-workflow-studio__flow-picker-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 10px;
  cursor: pointer;
  list-style: none;
}
.solar-workflow-studio__flow-picker-summary::-webkit-details-marker { display: none; }
.solar-workflow-studio__flow-picker-summary::before { content: '▸'; color: var(--solar-studio-muted); }
.solar-workflow-studio__flow-picker[open] .solar-workflow-studio__flow-picker-summary::before { content: '▾'; }
.solar-workflow-studio__flow-picker-content {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--solar-studio-border-subtle);
}
.solar-workflow-studio__field { display: grid; gap: 4px; min-width: 0; }
.solar-workflow-studio__field > span { color: var(--solar-studio-muted); font-size: 12px; }
.solar-workflow-studio__field-hint { line-height: 1.35; }
.solar-workflow-studio__advanced-fields { display: grid; gap: 7px; min-width: 0; }
.solar-workflow-studio__advanced-fields > summary { cursor: pointer; color: var(--solar-studio-muted); font-size: 12px; }
.solar-workflow-studio__advanced-content { display: grid; gap: 7px; padding-top: 1px; }
.solar-workflow-studio__field input,
.solar-workflow-studio__field select,
.solar-workflow-studio__field textarea {
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--solar-studio-border-subtle);
  border-radius: 6px;
  padding: 6px 8px;
  color: inherit;
  background: var(--solar-studio-control);
}
.solar-workflow-studio__field textarea { min-height: 82px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.solar-workflow-studio__field textarea[data-prompt="true"] { min-height: 124px; font-family: inherit; }
.solar-workflow-studio__list { display: grid; gap: 5px; }
.solar-workflow-studio__list button { text-align: left; }
.solar-workflow-studio__selected { outline: 1px solid var(--solar-studio-accent); outline-offset: 0; background: var(--solar-studio-accent-soft); }
.solar-workflow-studio__run-card { display: grid; gap: 5px; padding: 8px; border: 1px solid var(--solar-studio-border-subtle); border-radius: 7px; background: color-mix(in srgb, var(--solar-studio-control) 72%, transparent); }
.solar-workflow-studio__status { font-size: 12px; color: var(--solar-studio-muted); }
.solar-workflow-studio__status[data-status="completed"] { color: var(--solar-studio-success); }
.solar-workflow-studio__status[data-status="failed"],
.solar-workflow-studio__status[data-status="cancelled"],
.solar-workflow-studio__status[data-status="unknown"] { color: var(--solar-studio-error); }
.solar-workflow-studio__result {
  max-height: 14rem;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 8px;
  border-radius: 6px;
  background: var(--solar-studio-control);
}
.solar-workflow-studio__evidence { gap: 6px; }
.solar-workflow-studio__evidence-details { display: grid; gap: 7px; }
.solar-workflow-studio__evidence-details > summary { cursor: pointer; color: var(--solar-studio-muted); font-size: 12px; }
.solar-workflow-studio__resume-action { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.solar-workflow-studio__resume-action > span { font-size: 12px; }

@container workflow-studio (max-width: 900px) {
  .solar-workflow-studio__layout { grid-template-columns: minmax(0, 1fr); }
  .solar-workflow-studio__inspector { min-height: unset; }
  .solar-workflow-studio__canvas { min-height: 360px; }
}

@container workflow-studio (max-width: 560px) {
  .solar-workflow-studio__flow-picker-content { grid-template-columns: minmax(0, 1fr); }
  .solar-workflow-studio__toolbar-group { width: 100%; padding-right: 0; border-right: 0; }
  .solar-workflow-studio__execution-action > span { min-width: 0; }
  .solar-workflow-studio__canvas { min-height: 320px; }
}

.solar-session-mode {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-primary, inherit);
}
.solar-session-mode__label { color: var(--dsw-alias-label-secondary, inherit); font-size: .86rem; }
.solar-session-mode button { min-height: 28px; padding: 4px 8px; border-radius: 7px; }
.solar-session-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary, #ba7dff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ba7dff) 14%, transparent); }
.solar-session-mode__error { width: 100%; color: var(--dsw-alias-state-error-primary, #e87070); font-size: .85rem; }

@media (max-width: 780px) {
  .solar-workflow-studio { padding: 10px; }
  .solar-workflow-studio__layout { grid-template-columns: minmax(0, 1fr); }
  .solar-workflow-studio__inspector { min-height: unset; }
  .solar-workflow-studio__canvas { min-height: 320px; }
  .solar-workflow-studio__flow-picker-content { grid-template-columns: minmax(0, 1fr); }
}
`

const sessionModeCss = `
.solar-session-mode {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-primary, inherit);
}
.solar-session-mode__label { color: var(--dsw-alias-label-secondary, inherit); font-size: .86rem; }
.solar-session-mode button { min-height: 28px; padding: 4px 8px; border-radius: 7px; }
.solar-session-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary, #ba7dff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ba7dff) 14%, transparent); }
.solar-session-mode__error { width: 100%; color: var(--dsw-alias-state-error-primary, #e87070); font-size: .85rem; }
`

/** Rendered once by each isolated panel. It includes both React Flow's base rules and Solar's theme rules. */
export function WorkflowStudioStyles(): ReactElement {
  return createElement('style', { 'data-solar-workflow-studio': 'true' }, workflowStudioCss)
}

export function SessionModeStyles(): ReactElement {
  return createElement('style', { 'data-solar-session-mode': 'true' }, sessionModeCss)
}
