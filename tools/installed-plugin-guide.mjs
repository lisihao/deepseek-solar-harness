import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const snapshot = JSON.parse(await readFile(`${root}docs/installed-plugins-2026-10-22-tool-context.json`, 'utf8'))
const begin = '<!-- SOLAR-INSTALLED-PLUGINS:START -->'
const end = '<!-- SOLAR-INSTALLED-PLUGINS:END -->'
const purpose = {
  'dshmarket': '社区插件发现与管理', 'dsh-context': '上下文组成、变化与历史',
  'dsh-cost-meter': 'Token 和费用估算；不是账单', 'dsh-codex-subscription': '以现有 ChatGPT/Codex 订阅接入主对话',
  'dsh-thoughtdag': '会话思维图', '@feng0531/dsh-code-review': 'Git/SVN 只读代码审查',
  '@tt-a1i/archify-dsh': '仓库架构图技能', '@vectorize-io/hindsight-coding-agents': 'Hindsight 项目记忆；另需后端配置',
  '@wxg-prc-cpg/browser-skill-dsh-plugin': 'BrowserSkill 浏览器工具；按需安装外部依赖',
  '@linxin666/dsh-client-ui-git-graph': 'Git 图与分支操作', '@linxin666/dsh-liangshen': '梁神 Agent 预置',
  'dsh-loopx-plugin': 'LoopX 目标与同会话循环；进阶试用', 'dsh-deepseek-web-login': '非官方 DeepSeek 网页接入；另需登录',
  'dsh-chat-import': '从其他工具导入会话', 'dsh-synapse': '非线性会话工作区',
  'dsh-agent-persona': '按工作区或会话配置人设', 'dsh-mnemon': '可组合记忆来源与视图',
  '@dickpy/dsh-imagegen': '生图；另需配置提供商', 'graph-memory': '知识图谱记忆；另需后端依赖',
  'clearai-dsh': '证据驱动研究与领域本体预置', 'dsh-purge-community': '修改官方 App runtime/CLI；仅记录已安装状态，不属于 D1 推荐配置',
  'dsh-session-prefix': '会话阶段前缀；Jev/Agent 工具路径需独立配置',
  '@dsh-jev/plugin': 'Jev 决策集成；需独立配置，不默认启用能力',
  'dsh-univer-office': 'Univer 文档预览与协作工作区',
  'dsh-research-report': '带证据账本和验证信息的研究报告',
  'dsh-industry-research': '行业/公司研究工具与方法技能',
  '@lisihao/dsh-solar-native-resident': '持久原生任务、会话通道和本机调度',
  '@lisihao/dsh-solar-native-collaboration': '普通/智能协同与执行流程编辑',
  '@lisihao/dsh-solar-model-handoff': '原生模型上下文交接与 Web 返回范围选择',
  '@lisihao/dsh-solar-chatgpt-web': 'ChatGPT 网页算子和洞察分析；实验性',
  '@lisihao/dsh-solar-skill-context': '技能按需检索；旧完整目录退出请求、原日志保留',
  '@lisihao/dsh-solar-rlm': '原始 Prime RLM/Continual Harness 适配；实验性',
  'billion-context': 'Solar 维护的上下文压缩预检修复', 'dsh-dream-skin': 'Solar 维护的壁纸轮换/本地文件夹图源',
}
purpose['@lisihao/dsh-solar-tool-context'] = '工具声明按需发现和加载；保留原权限与原始日志'
purpose['dsh-grok-subscription'] = '以现有 Grok 订阅接入；另需登录配置'
purpose['dsh-subscription-hub'] = '本机订阅设置分组；公开安装来源待确认'
purpose['dsh-purge-rightbar'] = '本机 Purge 右侧栏入口；公开安装来源待确认'
const officialPurpose = ['基础运行环境', '原生 Web 界面', 'Agent 团队', '语音输入', '检查器', '自动审批', '思考翻译', 'Git worktree 工具', '终端', 'Codex 子智能体', 'Claude Code 子智能体', 'Ralph 循环', '插件市场', '会话搜索', '会话标题', '技能徽章']
const row = (p, description, command) => `| ${p.maintainedSourceRepo ?? p.repository ? `[\`${p.name}\`](${p.maintainedSourceRepo ?? p.repository})` : `\`${p.name}\``} | \`${p.version}\` | ${description} | ${command} |`
const header = '| 插件 | 快照版本 | 用途 | 安装或启用方式 |\n|---|---|---|---|'
const curated = snapshot.plugins.filter(p => p.category === 'curated')
const community = snapshot.plugins.filter(p => p.category === 'community')
const official = snapshot.plugins.filter(p => p.category === 'official')
const body = [
  `核对日期：2026-10-22（America/Toronto）。profile 配置共 **${snapshot.plugins.length} 个 bundle**：${official.length} 个官方、${community.length} 个社区原版、${curated.length} 个本仓库精选验证包（${curated.filter(p => p.name.startsWith('@lisihao/')).length} 个 Solar 自研、${curated.filter(p => !p.name.startsWith('@lisihao/')).length} 个维护 fork）。这是配置和已安装包元数据快照；不表示本轮逐个验证了 GUI 开关或真实功能，也不表示最新版本。`,
  '[机器可读清单](docs/installed-plugins-2026-10-22-tool-context.json)不包含账号、配置值、会话或本机安装路径。',
  `### 自研与维护包：${curated.length} 项`, [header, ...curated.map(p => row(p, purpose[p.name], `\`bash "$work/install.sh" --ref "$ref" ${p.packageId}\``))].join('\n'),
  `### 社区原版：${community.length} 项`,
  '先完成上方的退出与备份步骤，并设置 `DSH_CLI`。以下每一行只安装对应插件；不需要全部执行。已确认的公开来源为作者的 npm 包、固定 Git 提交或版本化 Release，不由本仓库重新打包。两项本地包尚未确认公开来源，因此不提供安装命令。安装成功不等于账号、外部依赖或真实执行已验收。`dsh-purge-community` 会修改官方 App runtime/CLI，与本项目保持官方 App 不变的 D1 约束不一致；该行仅记录已有安装，不构成推荐配置。', [header, ...community.map(p => row(p, purpose[p.name], p.installSpec ? `\`"$DSH_CLI" plugin --profile desktop add '${p.installSpec}'\`` : '本机本地包；公开来源与可复现安装方式尚未确认，暂不提供命令'))].join('\n'),
  '### 官方内置：16 项',
  '这些条目随已安装官方 App/运行环境提供；在「插件 → 已安装」或官方内置插件设置中按需启用。基础运行环境和原生 Web 界面不需要重复安装。下表官方版本按已发布 App 基线列出；不会用这些开关复制他人的账号或配置。', [header, ...official.map((p, index) => row(p, officialPurpose[index], index < 2 ? '随官方 App 提供' : '在官方插件设置中启用；按需完成其登录/依赖配置'))].join('\n'),
].join('\n\n')
const readmePath = `${root}README.md`
const current = await readFile(readmePath, 'utf8')
if (!current.includes(begin) || !current.includes(end)) throw new Error('Missing installed plugin guide markers')
const next = current.slice(0, current.indexOf(begin)) + `${begin}\n${body}\n${end}` + current.slice(current.indexOf(end) + end.length)
if (process.argv.includes('--check')) {
  if (current !== next) throw new Error('Installed plugin guide is stale; run node tools/installed-plugin-guide.mjs')
  console.log(`Installed plugin guide matches ${snapshot.plugins.length} snapshot entries.`)
} else await writeFile(readmePath, next)
