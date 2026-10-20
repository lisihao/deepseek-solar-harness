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
  --solar-studio-border: var(--dsw-alias-settings-card-stroke, rgba(127, 127, 127, .34));
  --solar-studio-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-module-platform, #20242b));
  --solar-studio-surface: var(--dsw-alias-bg-base, #15171b);
  --solar-studio-text: var(--dsw-alias-label-primary, #f3f4f6);
  --solar-studio-muted: var(--dsw-alias-label-secondary, #a0a6b2);
  --solar-studio-success: var(--dsw-alias-state-success-primary, #44b78b);
  --solar-studio-error: var(--dsw-alias-state-error-primary, #e87070);
  color: var(--solar-studio-text);
  display: grid;
  gap: 8px;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  background: var(--solar-studio-surface);
  container-type: inline-size;
  container-name: workflow-studio;
}

.solar-workflow-studio h1,
.solar-workflow-studio h2,
.solar-workflow-studio h3,
.solar-workflow-studio p,
.solar-workflow-studio pre,
.solar-workflow-studio ul { margin: 0; }

.solar-workflow-studio__intro,
.solar-workflow-studio__toolbar,
.solar-workflow-studio__panel,
.solar-workflow-studio__inspector,
.solar-workflow-studio__flow-picker,
.solar-workflow-studio__run-list {
  min-width: 0;
  border: 1px solid var(--solar-studio-border);
  border-radius: 10px;
  background: var(--solar-studio-card);
}

.solar-workflow-studio__intro { padding: 4px 2px; display: grid; gap: 4px; }
.solar-workflow-studio__intro h1,
.solar-workflow-studio__intro h2,
.solar-workflow-studio__inspector h2,
.solar-workflow-studio__panel h2 { margin: 0; font-size: 1rem; }
.solar-workflow-studio__intro p,
.solar-workflow-studio__panel p,
.solar-workflow-studio__inspector p { margin: 0; }
.solar-workflow-studio__muted { color: var(--solar-studio-muted); overflow-wrap: anywhere; }
.solar-workflow-studio__error { color: var(--solar-studio-error); overflow-wrap: anywhere; }
.solar-workflow-studio__success { color: var(--solar-studio-success); overflow-wrap: anywhere; }

.solar-workflow-studio__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border: 0;
  background: transparent;
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
  padding: 5px 8px;
  border: 1px solid var(--solar-studio-border);
  border-radius: 6px;
  background: var(--dsw-alias-bg-module-platform, transparent);
  color: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.solar-workflow-studio button:disabled { cursor: not-allowed; opacity: .58; }
.solar-workflow-studio button[data-variant="primary"] { border-color: var(--solar-studio-success); }
.solar-workflow-studio button[data-variant="danger"] { border-color: var(--solar-studio-error); }

.solar-workflow-studio__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 330px);
  gap: 10px;
  min-width: 0;
}

.solar-workflow-studio__canvas-column { display: grid; gap: 10px; min-width: 0; }
.solar-workflow-studio__canvas {
  min-height: 380px;
  border: 1px solid var(--solar-studio-border);
  border-radius: 10px;
  overflow: hidden;
  background-color: var(--solar-studio-surface);
  background-image: radial-gradient(var(--solar-studio-border) 1px, transparent 1px);
  background-size: 18px 18px;
}

.solar-workflow-studio .react-flow { background: transparent; }
.solar-workflow-studio .react-flow__controls { box-shadow: none; border: 1px solid var(--solar-studio-border); }
.solar-workflow-studio .react-flow__controls-button {
  background: var(--solar-studio-card);
  background-image: none;
  color: var(--solar-studio-text);
  fill: currentColor;
  border-bottom-color: var(--solar-studio-border);
}
.solar-workflow-studio .react-flow__controls-fitview { background: var(--solar-studio-card); color: var(--solar-studio-text); }
.solar-workflow-studio .react-flow__controls-button svg,
.solar-workflow-studio .react-flow__controls-button svg path { fill: currentColor; }
.solar-workflow-studio .react-flow__edge-path { stroke: var(--solar-studio-muted); stroke-width: 1.5; }
.solar-workflow-studio .react-flow__handle { width: 8px; height: 8px; background: var(--solar-studio-success); border-color: var(--solar-studio-card); }
.solar-workflow-studio .react-flow__node { border-radius: 8px; }

.solar-workflow-studio__stage {
  min-width: 150px;
  max-width: 220px;
  display: grid;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--solar-studio-border);
  border-radius: 8px;
  color: var(--solar-studio-text);
  background: var(--solar-studio-card);
  box-shadow: 0 5px 16px rgba(0, 0, 0, .16);
}

.solar-workflow-studio__stage[data-status="running"],
.solar-workflow-studio__stage[data-status="pending"] { border-left: 3px solid var(--solar-studio-success); }
.solar-workflow-studio__stage[data-status="failed"],
.solar-workflow-studio__stage[data-status="unknown"] { border-left: 3px solid var(--solar-studio-error); }
.solar-workflow-studio__stage-title { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }
.solar-workflow-studio__stage-kind { color: var(--solar-studio-muted); font-size: .78rem; overflow-wrap: anywhere; }

.solar-workflow-studio__inspector,
.solar-workflow-studio__panel,
.solar-workflow-studio__run-list { padding: 10px; display: grid; align-content: start; gap: 8px; }
.solar-workflow-studio__inspector { min-height: 0; align-self: start; }
.solar-workflow-studio__flow-picker { min-width: 0; }
.solar-workflow-studio__flow-picker-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
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
  gap: 10px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--solar-studio-border);
}
.solar-workflow-studio__field { display: grid; gap: 5px; min-width: 0; }
.solar-workflow-studio__field > span { color: var(--solar-studio-muted); font-size: .85rem; }
.solar-workflow-studio__field-hint { line-height: 1.35; }
.solar-workflow-studio__field input,
.solar-workflow-studio__field select,
.solar-workflow-studio__field textarea {
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--solar-studio-border);
  border-radius: 6px;
  padding: 7px 8px;
  color: inherit;
  background: var(--dsw-alias-bg-module-platform, transparent);
}
.solar-workflow-studio__field textarea { min-height: 86px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.solar-workflow-studio__field textarea[data-prompt="true"] { min-height: 130px; font-family: inherit; }
.solar-workflow-studio__list { display: grid; gap: 6px; }
.solar-workflow-studio__list button { text-align: left; }
.solar-workflow-studio__selected { outline: 2px solid var(--solar-studio-success); outline-offset: 1px; }
.solar-workflow-studio__run-card { display: grid; gap: 5px; padding: 9px; border: 1px solid var(--solar-studio-border); border-radius: 7px; }
.solar-workflow-studio__status { font-size: .84rem; color: var(--solar-studio-muted); }
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
  background: var(--dsw-alias-bg-module-platform, transparent);
}
.solar-workflow-studio__evidence { gap: 6px; }
.solar-workflow-studio__evidence-details { display: grid; gap: 8px; }
.solar-workflow-studio__evidence-details > summary { cursor: pointer; color: var(--solar-studio-muted); }
.solar-workflow-studio__resume-action { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.solar-workflow-studio__resume-action > span { font-size: .82rem; }

@container workflow-studio (max-width: 900px) {
  .solar-workflow-studio__layout { grid-template-columns: minmax(0, 1fr); }
  .solar-workflow-studio__inspector { min-height: unset; }
  .solar-workflow-studio__canvas { min-height: 350px; }
}

@container workflow-studio (max-width: 560px) {
  .solar-workflow-studio__flow-picker-content { grid-template-columns: minmax(0, 1fr); }
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
.solar-session-mode button { min-height: 28px; padding: 4px 8px; }
.solar-session-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-state-success-primary, #44b78b); }
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
.solar-session-mode button { min-height: 28px; padding: 4px 8px; }
.solar-session-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-state-success-primary, #44b78b); }
.solar-session-mode__error { width: 100%; color: var(--dsw-alias-state-error-primary, #e87070); font-size: .85rem; }
`

/** Rendered once by each isolated panel. It includes both React Flow's base rules and Solar's theme rules. */
export function WorkflowStudioStyles(): ReactElement {
  return createElement('style', { 'data-solar-workflow-studio': 'true' }, workflowStudioCss)
}

export function SessionModeStyles(): ReactElement {
  return createElement('style', { 'data-solar-session-mode': 'true' }, sessionModeCss)
}
