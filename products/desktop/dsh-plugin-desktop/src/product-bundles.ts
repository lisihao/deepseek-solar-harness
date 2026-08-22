/** Desktop-owned product bundles whose executable code is sealed into the App. */

export const RESIDENT_BUNDLE_PACKAGE = '@deepseek-ai/dsh-resident-operators'
export const ORCHESTRATION_BUNDLE_PACKAGE = '@deepseek-ai/dsh-orchestrations'
export const AGENT_TEAMS_PACKAGE = '@nanmicoder/dsh-agent-teams'
export const AGENT_TEAMS_ROW_ID = 'agent-teams'
export const REMOTE_WEB_UI_PACKAGE = '@linxin666/dsh-remote-web-ui'
export const WEB_BILLING_PACKAGE = 'dsh-web-billing'
export const LUNA_VISION_BRIDGE_PACKAGE = '@ycp424c/dsh-luna-vision-bridge'
export const CODE_HARNESS_GOVERNANCE_PACKAGE = '@lisihao/dsh-code-harness-governance'
export const PLUGIN_CONSOLE_PACKAGE = '@vlln/plugin-console'
export const PLUGIN_CONSOLE_ROW_ID = 'plugin-console'
export const UI_REMOTE_MODULES_PACKAGE = '@deepseek-ai/dsh-client-ui-remote-modules'
export const UI_REMOTE_MODULES_ROW_ID = 'ui-remote-modules'
export const HOST_APIPROXY_PACKAGE = '@deepseek-ai/dsh-host-apiproxy'
export const MEMORY_EVOLVE_PACKAGE = 'dsh-memory-evolve'

export const PRODUCT_BUNDLE_ROW_IDS = new Map<string, string>([
  [RESIDENT_BUNDLE_PACKAGE, 'resident-operators'],
  [ORCHESTRATION_BUNDLE_PACKAGE, 'orchestration-local'],
  [AGENT_TEAMS_PACKAGE, AGENT_TEAMS_ROW_ID],
  [REMOTE_WEB_UI_PACKAGE, 'remote-web-ui'],
  [WEB_BILLING_PACKAGE, 'web-billing'],
  [LUNA_VISION_BRIDGE_PACKAGE, 'luna-vision-bridge'],
  [CODE_HARNESS_GOVERNANCE_PACKAGE, 'code-harness-governance'],
  [PLUGIN_CONSOLE_PACKAGE, PLUGIN_CONSOLE_ROW_ID],
  [UI_REMOTE_MODULES_PACKAGE, UI_REMOTE_MODULES_ROW_ID],
  [MEMORY_EVOLVE_PACKAGE, 'dsh-memory-evolve'],
])

export const PRODUCT_BUNDLE_PACKAGES = [
  RESIDENT_BUNDLE_PACKAGE,
  ORCHESTRATION_BUNDLE_PACKAGE,
  AGENT_TEAMS_PACKAGE,
  REMOTE_WEB_UI_PACKAGE,
  WEB_BILLING_PACKAGE,
  LUNA_VISION_BRIDGE_PACKAGE,
  CODE_HARNESS_GOVERNANCE_PACKAGE,
  PLUGIN_CONSOLE_PACKAGE,
  UI_REMOTE_MODULES_PACKAGE,
  MEMORY_EVOLVE_PACKAGE,
] as const

/** App-sealed runtime packages that must stay version-aligned with product bundles. */
export const SEALED_RUNTIME_PACKAGES = [
  ...PRODUCT_BUNDLE_PACKAGES,
  HOST_APIPROXY_PACKAGE,
] as const
