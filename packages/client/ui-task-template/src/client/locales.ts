export const en = {
  nav: 'Task templates', title: 'Task prompt templates',
  intro: 'Match reusable methods to task characteristics. The planner injects the best enabled match into every supported operator.',
  add: 'New template', empty: 'No templates yet. Create one for reports, research, coding, or another recurring task.',
  enabled: 'Enabled', disabled: 'Disabled', edit: 'Edit', remove: 'Delete', cancel: 'Cancel', save: 'Save', saving: 'Saving…',
  createTitle: 'Create template', editTitle: 'Edit template', id: 'Template ID', idHint: 'Lowercase letters, digits, and dashes; cannot change later.',
  name: 'Name', rank: 'Priority rank', rankHint: 'Higher wins when equally specific.', method: 'Reusable method',
  methodHint: 'Variables: {{objective}}, {{taskType}}, {{domain}}, {{outputFormat}}, {{language}}.',
  taskTypes: 'Task types', domains: 'Domains', outputFormats: 'Output formats', operators: 'Operators',
  tools: 'Required tools', skills: 'Required skills', languages: 'Languages', risks: 'Risk levels', priorities: 'Task priorities', keywords: 'Objective keywords',
  commaHint: 'Comma-separated. Empty means any value.', preferences: 'Personal preferences', memory: 'Task-specific memory',
  privateHint: 'Preferences and memory stay in the local DSH private-data directory and are never packaged into the repository.',
  version: 'Version', history: 'prior revisions', loadFailed: 'Could not load task templates', retry: 'Retry', confirmDelete: 'Delete this template and its private personalization?',
}

export type TaskTemplateLocaleKey = keyof typeof en
export const zh: { [K in TaskTemplateLocaleKey]: string } = {
  nav: '任务模板', title: '任务级提示词模板库',
  intro: '按任务特征匹配可复用方法；规划器会把最合适的启用模板注入所有受支持算子。',
  add: '新建模板', empty: '还没有模板。可先创建洞察报告、研究、编码或其他重复任务模板。',
  enabled: '已启用', disabled: '已停用', edit: '编辑', remove: '删除', cancel: '取消', save: '保存', saving: '保存中…',
  createTitle: '新建模板', editTitle: '编辑模板', id: '模板 ID', idHint: '仅小写字母、数字和短横线，创建后不可修改。',
  name: '名称', rank: '排序权重', rankHint: '匹配精度相同时，数值越高越优先。', method: '可复用方法提示词',
  methodHint: '可用变量：{{objective}}、{{taskType}}、{{domain}}、{{outputFormat}}、{{language}}。',
  taskTypes: '任务类型', domains: '领域', outputFormats: '输出格式', operators: '适用算子',
  tools: '必需工具', skills: '必需技能', languages: '语言', risks: '风险等级', priorities: '任务优先级', keywords: '目标关键词',
  commaHint: '用逗号分隔；留空表示不限。', preferences: '个人偏好', memory: '任务专属记忆',
  privateHint: '偏好和记忆只保存在 DSH 本机私有数据目录，不会打包进源码仓库。',
  version: '版本', history: '个历史版本', loadFailed: '无法加载任务模板', retry: '重试', confirmDelete: '删除此模板及其私有个性化内容？',
}
