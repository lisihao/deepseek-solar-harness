/** Desktop-owned product bundles whose executable code is sealed into the App. */

export const RESIDENT_BUNDLE_PACKAGE = '@deepseek-ai/dsh-resident-operators'
export const ORCHESTRATION_BUNDLE_PACKAGE = '@deepseek-ai/dsh-orchestrations'
export const EGO_LITE_BROWSER_BUNDLE_PACKAGE = '@deepseek-ai/dsh-ego-lite-browser'
export const EGO_LITE_BROWSER_ROW_ID = 'browser'
export const ARCHIFY_PACKAGE = '@deepseek-ai/dsh-archify'
export const ARCHIFY_ROW_ID = 'archify'
export const AGENT_TEAMS_PACKAGE = '@nanmicoder/dsh-agent-teams'
export const AGENT_TEAMS_ROW_ID = 'agent-teams'
export const REMOTE_WEB_UI_PACKAGE = '@linxin666/dsh-remote-web-ui'
export const BLUE_FANTASY_SKIN_PACKAGE = '@linxin666/dsh-client-ui-skin-blue-fantasy'
export const LIANGSHEN_PACKAGE = '@linxin666/dsh-liangshen'
export const LIANGSHEN_ROW_ID = 'liangshen'
export const WEB_BILLING_PACKAGE = 'dsh-web-billing'
export const CODE_HARNESS_GOVERNANCE_PACKAGE = '@lisihao/dsh-code-harness-governance'
export const PLUGIN_CONSOLE_PACKAGE = '@vlln/plugin-console'
export const PLUGIN_CONSOLE_ROW_ID = 'plugin-console'
export const UI_REMOTE_MODULES_PACKAGE = '@deepseek-ai/dsh-client-ui-remote-modules'
export const UI_REMOTE_MODULES_ROW_ID = 'ui-remote-modules'
export const HOST_APIPROXY_PACKAGE = '@deepseek-ai/dsh-host-apiproxy'
export const GENUI_PACKAGE = '@omdsh-dev/dsh-genui'
export const PLUGIN_CHECK_PACKAGE = '@omdsh-dev/dsh-plugin-check'
export const LLM_FALLBACKS_PACKAGE = 'dsh-llm-fallbacks'
export const TOOL_STAT_PACKAGE = '@deepseek-ai/dsh-tool-stat'
export const TOOL_TIME_PACKAGE = '@deepseek-ai/dsh-tool-time'
export const TOOL_REGEX_PACKAGE = '@deepseek-ai/dsh-tool-regex'
export const TOOL_MARKDOWN_PACKAGE = '@deepseek-ai/dsh-tool-markdown'
export const CODEGRAPH_PACKAGE = 'dsh-codegraph'
export const MNEMON_PACKAGE = 'dsh-mnemon'
export const AEGIS_PACKAGE = 'aegis'
export const BETTER_SIDEBAR_PACKAGE = 'dsh-better-sidebar'

export const PRODUCT_BUNDLE_ROW_IDS = new Map<string, string>([
  [RESIDENT_BUNDLE_PACKAGE, 'resident-operators'],
  [ORCHESTRATION_BUNDLE_PACKAGE, 'orchestration-local'],
  [EGO_LITE_BROWSER_BUNDLE_PACKAGE, EGO_LITE_BROWSER_ROW_ID],
  [ARCHIFY_PACKAGE, ARCHIFY_ROW_ID],
  [AGENT_TEAMS_PACKAGE, AGENT_TEAMS_ROW_ID],
  [REMOTE_WEB_UI_PACKAGE, 'remote-web-ui'],
  [LIANGSHEN_PACKAGE, LIANGSHEN_ROW_ID],
  [WEB_BILLING_PACKAGE, 'web-billing'],
  [CODE_HARNESS_GOVERNANCE_PACKAGE, 'code-harness-governance'],
  [PLUGIN_CONSOLE_PACKAGE, PLUGIN_CONSOLE_ROW_ID],
  [UI_REMOTE_MODULES_PACKAGE, UI_REMOTE_MODULES_ROW_ID],
  [GENUI_PACKAGE, 'genui'],
  [PLUGIN_CHECK_PACKAGE, 'tool-plugin-check'],
  [LLM_FALLBACKS_PACKAGE, 'llm-fallbacks'],
  [TOOL_STAT_PACKAGE, 'tool-stat'],
  [TOOL_TIME_PACKAGE, 'tool-time'],
  [TOOL_REGEX_PACKAGE, 'tool-regex'],
  [TOOL_MARKDOWN_PACKAGE, 'tool-markdown'],
  [CODEGRAPH_PACKAGE, 'codegraph'],
  [MNEMON_PACKAGE, 'mnemon'],
  [AEGIS_PACKAGE, 'aegis-method-pack'],
  [BETTER_SIDEBAR_PACKAGE, 'better-sidebar'],
])

export const PRODUCT_BUNDLE_PACKAGES = [
  RESIDENT_BUNDLE_PACKAGE,
  ORCHESTRATION_BUNDLE_PACKAGE,
  EGO_LITE_BROWSER_BUNDLE_PACKAGE,
  ARCHIFY_PACKAGE,
  AGENT_TEAMS_PACKAGE,
  REMOTE_WEB_UI_PACKAGE,
  LIANGSHEN_PACKAGE,
  WEB_BILLING_PACKAGE,
  CODE_HARNESS_GOVERNANCE_PACKAGE,
  PLUGIN_CONSOLE_PACKAGE,
  UI_REMOTE_MODULES_PACKAGE,
  GENUI_PACKAGE,
  PLUGIN_CHECK_PACKAGE,
  LLM_FALLBACKS_PACKAGE,
  TOOL_STAT_PACKAGE,
  TOOL_TIME_PACKAGE,
  TOOL_REGEX_PACKAGE,
  TOOL_MARKDOWN_PACKAGE,
  CODEGRAPH_PACKAGE,
  MNEMON_PACKAGE,
  AEGIS_PACKAGE,
  BETTER_SIDEBAR_PACKAGE,
] as const

/** App-sealed runtime packages that must stay version-aligned with product bundles. */
export const SEALED_RUNTIME_PACKAGES = [
  ...PRODUCT_BUNDLE_PACKAGES,
  BLUE_FANTASY_SKIN_PACKAGE,
  HOST_APIPROXY_PACKAGE,
] as const
