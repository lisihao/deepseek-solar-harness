/** Localized copy for the Remote Modules configuration tab. */

/** Locale keys rendered by the configuration surface. */
export type RemoteModulesSettingsKey =
  | 'tab' | 'title' | 'intro' | 'restartNotice' | 'loading' | 'unavailable' | 'readOnly'
  | 'add' | 'module' | 'delete' | 'id' | 'label' | 'url' | 'relayPort' | 'order'
  | 'idHint' | 'urlHint' | 'relayPortHint' | 'orderHint'
  | 'save' | 'saving' | 'discard' | 'reset' | 'saved' | 'saveFailed' | 'conflict'
  | 'required' | 'invalidId' | 'duplicateId' | 'invalidUrl'
  | 'invalidPort' | 'duplicatePort' | 'invalidOrder'

/** English copy. */
export const en: Record<RemoteModulesSettingsKey, string> = {
  tab: 'Remote Modules',
  title: 'Remote Modules',
  intro: 'Create multiple sidebar modules. Each module opens the configured target Web application itself.',
  restartNotice: 'Saved changes take effect after Harness restarts because relay listeners are created at startup.',
  loading: 'Loading plugin settings…',
  unavailable: 'Remote Modules settings are not exposed by this deployment.',
  readOnly: 'This deployment stores settings read-only.',
  add: 'Add module',
  module: 'Module',
  delete: 'Delete module',
  id: 'Instance ID',
  label: 'Display name',
  url: 'Target Web page',
  relayPort: 'Local relay port',
  order: 'Sidebar order',
  idHint: 'Lowercase kebab-case; for example research-workspace or model-console.',
  urlHint: 'Full HTTP(S) page address, including an optional path.',
  relayPortHint: '0 chooses a temporary port. Use a stable unique port to preserve target login state.',
  orderHint: 'Smaller numbers appear first in the vertical sidebar list.',
  save: 'Save configuration',
  saving: 'Saving…',
  discard: 'Discard changes',
  reset: 'Restore deployment defaults',
  saved: 'Configuration saved. Restart Harness to apply it.',
  saveFailed: 'Harness rejected the configuration. Correct the fields and save again.',
  conflict: 'The settings file changed while this draft was open. Discard the draft before editing again.',
  required: 'This field is required.',
  invalidId: 'Use lowercase letters, numbers, and single hyphens.',
  duplicateId: 'Instance IDs must be unique.',
  invalidUrl: 'Enter an HTTP(S) URL without embedded credentials.',
  invalidPort: 'Enter a whole number from 0 to 65535.',
  duplicatePort: 'Each non-zero relay port must be unique.',
  invalidOrder: 'Enter a whole number.',
}

/** Simplified Chinese copy. */
export const zh: Record<RemoteModulesSettingsKey, string> = {
  tab: '远程模块',
  title: 'Remote Modules',
  intro: '创建多个侧栏模块；每个模块打开用户配置的目标 Web 应用本身。',
  restartNotice: '中继监听器在启动时创建，因此保存后需重启 Harness 才会生效。',
  loading: '正在加载插件配置…',
  unavailable: '当前部署没有开放 Remote Modules 配置。',
  readOnly: '当前部署的设置为只读。',
  add: '增加模块',
  module: '模块',
  delete: '删除模块',
  id: '实例 ID',
  label: '显示名称',
  url: '目标网页地址',
  relayPort: '本机中继端口',
  order: '侧栏顺序',
  idHint: '使用小写 kebab-case，例如 research-workspace 或 model-console。',
  urlHint: '完整 HTTP(S) 网页地址，可包含页面路径。',
  relayPortHint: '填 0 使用临时端口；稳定且唯一的端口可保留目标应用登录状态。',
  orderHint: '数字越小，在纵向侧栏中越靠前。',
  save: '保存配置',
  saving: '保存中…',
  discard: '放弃修改',
  reset: '恢复部署默认值',
  saved: '配置已保存；重启 Harness 后生效。',
  saveFailed: 'Harness 拒绝了这份配置；请修正字段后重新保存。',
  conflict: '编辑期间设置文件已发生变化；请先放弃当前草稿，再重新编辑。',
  required: '此项必填。',
  invalidId: '只能使用小写字母、数字和单个连字符。',
  duplicateId: '实例 ID 不能重复。',
  invalidUrl: '请输入不含内嵌凭据的 HTTP(S) 地址。',
  invalidPort: '请输入 0 到 65535 之间的整数。',
  duplicatePort: '每个非零中继端口必须唯一。',
  invalidOrder: '请输入整数。',
}
