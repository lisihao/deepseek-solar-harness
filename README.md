# DeepSeek Solar Harness · 精选插件

在**未经修改的官方 DeepSeek Harness** 中安装、使用精选社区插件和 Solar 插件。此仓库不提供替代版 App，不复制账号、凭据、会话或个人配置。

这里给出本机已安装插件的固定版本快照、可复制的安装指令，以及我们开发或修改的插件验证包。**Solar 的 `0.1.0-dev.0` 包与维护 fork 是预览分发，不是稳定市场 Release。** 同版本的不同构建按完整源码提交和 SHA-256 区分；不要仅凭版本号判断是否相同。

- [精选包与校验目录](distribution/plugins/) · [机器可读包目录](distribution/plugins/catalog.json)
- [如何使用这八个插件](docs/curated-plugin-usage.md) · [安装、备份和恢复说明](docs/curated-plugin-installation.md)
- [全部已安装插件快照](docs/installed-plugins-2026-10-22.json) · [旧的 2026-10-19 快照](docs/installed-plugins-2026-10-19.json)

## 先选需要的插件

| 需求 | 建议入口 | 当前验收边界 |
|---|---|---|
| 看上下文和费用 | `dsh-context`、`dsh-cost-meter` | 社区原版；费用显示为估算 |
| 切换原生模型并保留任务 | `model-handoff` | 短任务免摘要调用、取消后新任务、Web 进入/返回选择和提示框已验收；不保证摘要质量 |
| 多阶段原生任务和可编辑流程 | `native-resident` + `native-collaboration` | 持久化/调度的无密钥检查及流程编辑、保存重开已验收；真实任务结果需自行验收 |
| 网页回答、洞察分析 | `chatgpt-web` | **实验性**：旧安装包 `2c338f9` 的真实请求出现回执不匹配；新包 `67cd3aa` 已通过源码检查并安装核对；修复后真实回答链路尚未验收 |
| 技能目录过大、旧目录累积 | `skill-context` | 完整技能仍保留，按需搜索后由官方工具加载；原生模拟请求已验证，真实模型请求未运行 |
| 原始 Prime RLM | `rlm` | macOS arm64 原始运行时与本地机制检查；未证明普遍推理质量收益 |
| 修复压缩预检失败 | `billion-context` | Solar fork 的 `every compression tier is exhausted` 修复；不是 handoff 的替代品 |
| 壁纸列表/本地文件夹轮换 | `dream-skin` | Solar 维护 fork；个人图片不随包分发 |

**不要为“装齐”同时启用所有记忆、压缩、循环或浏览器插件。** 按实际需求选用，并分别完成各自要求的账号登录、浏览器或服务端配置。插件安装本身不授予 Agent 执行、文件写入或使用付费额度的任务权限。

技能目录修复的后续版本已将旧目录替换记录移到官方步骤打开之后，再在模型请求前确认持久化，避免严格会话读取器因日志顺序拒绝恢复。该修复不改写用户已有日志；[源码与验证说明](docs/skill-context-verification.md)区分历史版本和本次修正。

## 安装 Solar 自研和维护包

支持范围：**macOS arm64、官方 DeepSeek Harness `0.2.1-rc.2`、`desktop` profile**。先安装官方 App；本指令不安装 App。需要终端中的 `bash`、`curl`、`python3`，以及 App 自带的 `dsh` CLI。其他 App 或新版宿主不能据此视为兼容。

先正常退出 Harness App，等待 Host 和本机 Resident 没有活动或待调度任务并停止。不要强行终止执行中的工作。安装脚本会拒绝活动进程，备份当前 profile 文件，并只安装选中的插件及目录声明的依赖；它不会自动启动 App 或发送模型请求。

下面先把默认分支解析为**一个固定提交**，安装脚本、包目录和包文件都从该提交下载；不会在执行中追随不断变化的 `v4`。

```bash
work="$(mktemp -d "${TMPDIR:-/tmp}/solar-plugin-install.XXXXXX")"
curl -fSL 'https://api.github.com/repos/lisihao/deepseek-solar-harness/commits/v4' -o "$work/revision.json"
ref="$(python3 -c 'import json,re,sys; s=json.load(open(sys.argv[1]))["sha"]; assert re.fullmatch("[0-9a-f]{40}",s); print(s)' "$work/revision.json")"
curl -fSL "https://raw.githubusercontent.com/lisihao/deepseek-solar-harness/$ref/tools/install-curated-plugins.sh" -o "$work/install.sh"
bash "$work/install.sh" --ref "$ref" --list

# 示例：只安装原生协同、持久 Resident 和模型交接。
bash "$work/install.sh" --ref "$ref" native-resident native-collaboration model-handoff
```

每个包的独立命令见下方表格。RLM 的较大运行时按分片下载，合并后核对完整 tarball 的 SHA-256；不需要自己编译 Rust 或安装 Python 运行时依赖。`python3` 在此处是安装器读取 JSON/校验文件的依赖，与 RLM 自带的运行时不同。

安装完成后手动打开 Harness，在「插件 → 已安装」确认目标插件，再按[使用指南](docs/curated-plugin-usage.md)检查入口。**看到插件开关不等于真实模型链路成功。** Web/Insight、RLM 和原生执行消耗的额度及服务条件见指南；本安装步骤不运行这些测试。

## 安装社区原版前的共同准备

下方社区命令使用官方 App 的 CLI，不经过全局 npm 的另一份 Harness。先正常退出 App/Host、处理完 Resident 工作；在终端设置并检查 CLI，备份当前 `desktop` profile。不要把凭据或此备份上传到 GitHub。

```bash
DSH_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
test -x "$DSH_CLI" || { echo '未找到官方 App 的 CLI，请先安装受支持的官方 App。'; exit 1; }
backup="$HOME/.dsh/backups/community-plugins-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for name in package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.yml cordis.patch.yml compatibility.json; do
  test ! -f "$HOME/.dsh/profiles/desktop/$name" || cp -p "$HOME/.dsh/profiles/desktop/$name" "$backup/$name"
done
# 然后只复制下表中你需要的一条或几条 add 命令。
```

备份可能包含隐私文件且占用磁盘；保留在本机。恢复时先退出 App，按[恢复说明](docs/curated-plugin-installation.md#recovery)核对受影响文件，**不要把整个旧 profile 覆盖到后来已产生新设置或会话的环境**。

## 全部已安装插件与固定安装指令

安装快照中的 LoopX 使用了本机已有的兼容性许可；本仓库不会复制该许可或绕过宿主版本检查。若安装时报告版本不兼容，请停止并核对作者支持范围，不能把本机已安装当作其他环境可直接启用的保证。

<!-- SOLAR-INSTALLED-PLUGINS:START -->
核对日期：2026-10-22（Asia/Hong_Kong）。profile 配置共 **50 个 bundle**：16 个官方、26 个社区原版、8 个本仓库精选验证包（6 个 Solar 自研、2 个维护 fork）。这是配置和已安装包元数据快照；不表示本轮逐个验证了 GUI 开关或真实功能，也不表示最新版本。

[机器可读清单](docs/installed-plugins-2026-10-22.json)不包含账号、配置值、会话或本机安装路径。

### 自研与维护包：8 项

| 插件 | 快照版本 | 用途 | 安装或启用方式 |
|---|---|---|---|
| [`dsh-dream-skin`](https://github.com/lisihao/dsh-dream-skin) | `10.21.2-folder.2f6929c` | Solar 维护的壁纸轮换/本地文件夹图源 | `bash "$work/install.sh" --ref "$ref" dream-skin` |
| [`@lisihao/dsh-solar-native-resident`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | 持久原生任务、会话通道和本机调度 | `bash "$work/install.sh" --ref "$ref" native-resident` |
| [`@lisihao/dsh-solar-native-collaboration`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | 普通/智能协同与执行流程编辑 | `bash "$work/install.sh" --ref "$ref" native-collaboration` |
| [`billion-context`](https://github.com/lisihao/billion-context) | `0.1.202-solar.1` | Solar 维护的上下文压缩预检修复 | `bash "$work/install.sh" --ref "$ref" billion-context` |
| [`@lisihao/dsh-solar-model-handoff`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | 原生模型上下文交接与 Web 返回范围选择 | `bash "$work/install.sh" --ref "$ref" model-handoff` |
| [`@lisihao/dsh-solar-chatgpt-web`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | ChatGPT 网页算子和洞察分析；实验性 | `bash "$work/install.sh" --ref "$ref" chatgpt-web` |
| [`@lisihao/dsh-solar-rlm`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | 原始 Prime RLM/Continual Harness 适配；实验性 | `bash "$work/install.sh" --ref "$ref" rlm` |
| [`@lisihao/dsh-solar-skill-context`](https://github.com/lisihao/deepseek-solar-harness) | `0.1.0-dev.0` | 技能按需检索；旧完整目录退出请求、原日志保留 | `bash "$work/install.sh" --ref "$ref" skill-context` |

### 社区原版：26 项

先完成上方的退出与备份步骤，并设置 `DSH_CLI`。以下每一行只安装对应插件；不需要全部执行。来源为作者的 npm 包、固定 Git 提交或版本化 Release，不由本仓库重新打包。安装成功不等于账号、外部依赖或真实执行已验收。`dsh-purge-community` 会修改官方 App runtime/CLI，与本项目保持官方 App 不变的 D1 约束不一致；该行仅记录已有安装，不构成推荐配置。

| 插件 | 快照版本 | 用途 | 安装或启用方式 |
|---|---|---|---|
| [`dshmarket`](https://github.com/dsh-market/dsh-market) | `1.66.37` | 社区插件发现与管理 | `"$DSH_CLI" plugin --profile desktop add 'dshmarket@1.66.37'` |
| [`dsh-thoughtdag`](https://github.com/chenxiachan/thoughtdag) | `0.5.19` | 会话思维图 | `"$DSH_CLI" plugin --profile desktop add 'dsh-thoughtdag@0.5.19'` |
| [`@feng0531/dsh-code-review`](https://github.com/f-e-n-g-0531/dsh-code-review) | `0.84.0` | Git/SVN 只读代码审查 | `"$DSH_CLI" plugin --profile desktop add '@feng0531/dsh-code-review@0.84.0'` |
| [`@tt-a1i/archify-dsh`](https://github.com/tt-a1i/archify) | `1.0.0` | 仓库架构图技能 | `"$DSH_CLI" plugin --profile desktop add '@tt-a1i/archify-dsh@1.0.0'` |
| [`@vectorize-io/hindsight-coding-agents`](https://github.com/vectorize-io/hindsight) | `0.8.1` | Hindsight 项目记忆；另需后端配置 | `"$DSH_CLI" plugin --profile desktop add '@vectorize-io/hindsight-coding-agents@0.8.1'` |
| [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://github.com/Tencent/BrowserSkill) | `0.3.3` | BrowserSkill 浏览器工具；按需安装外部依赖 | `"$DSH_CLI" plugin --profile desktop add '@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.3'` |
| [`@linxin666/dsh-client-ui-git-graph`](https://github.com/zhu1090093659/dsh-web) | `0.4.7` | Git 图与分支操作 | `"$DSH_CLI" plugin --profile desktop add '@linxin666/dsh-client-ui-git-graph@0.4.7'` |
| [`dsh-context`](https://github.com/bowenliang123/dsh-context) | `0.73.3` | 上下文组成、变化与历史 | `"$DSH_CLI" plugin --profile desktop add 'dsh-context@0.73.3'` |
| [`@linxin666/dsh-liangshen`](https://github.com/zhu1090093659/dsh-web) | `0.4.7` | 梁神 Agent 预置 | `"$DSH_CLI" plugin --profile desktop add '@linxin666/dsh-liangshen@0.4.7'` |
| [`dsh-loopx-plugin`](https://github.com/loopx-project/loopx) | `0.1.1-beta.6` | LoopX 目标与同会话循环；进阶试用 | `"$DSH_CLI" plugin --profile desktop add 'https://github.com/loopx-project/loopx/releases/download/dsh-loopx-plugin-v0.1.1-beta.6/dsh-loopx-plugin-0.1.1-beta.6.tgz'` |
| [`dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login) | `1.0.3` | 非官方 DeepSeek 网页接入；另需登录 | `"$DSH_CLI" plugin --profile desktop add 'dsh-deepseek-web-login@1.0.3'` |
| [`dsh-codex-subscription`](https://github.com/WSL043/dsh-codex-subscription) | `3.1.1` | 以现有 ChatGPT/Codex 订阅接入主对话 | `"$DSH_CLI" plugin --profile desktop add 'dsh-codex-subscription@3.1.1'` |
| [`dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter) | `1.9.11` | Token 和费用估算；不是账单 | `"$DSH_CLI" plugin --profile desktop add 'dsh-cost-meter@1.9.11'` |
| [`dsh-chat-import`](https://github.com/Nwflower/dsh-chat-import) | `0.26.1` | 从其他工具导入会话 | `"$DSH_CLI" plugin --profile desktop add 'dsh-chat-import@0.26.1'` |
| [`dsh-synapse`](https://github.com/liangmianya/dsh-synapse) | `0.4.2` | 非线性会话工作区 | `"$DSH_CLI" plugin --profile desktop add 'github:liangmianya/dsh-synapse#847b712b14579ca5e5c5fcf414f4559589c44d93'` |
| [`dsh-agent-persona`](https://github.com/Awoodwhale/dsh-agent-persona) | `0.1.4` | 按工作区或会话配置人设 | `"$DSH_CLI" plugin --profile desktop add 'dsh-agent-persona@0.1.4'` |
| [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) | `0.5.32` | 可组合记忆来源与视图 | `"$DSH_CLI" plugin --profile desktop add 'dsh-mnemon@0.5.32'` |
| [`@dickpy/dsh-imagegen`](https://github.com/dickpy/dsh-imagegen) | `1.9.2` | 生图；另需配置提供商 | `"$DSH_CLI" plugin --profile desktop add '@dickpy/dsh-imagegen@1.9.2'` |
| [`graph-memory`](https://github.com/adoresever/graph-memory) | `1.6.0-beta.17` | 知识图谱记忆；另需后端依赖 | `"$DSH_CLI" plugin --profile desktop add 'github:adoresever/graph-memory#5841b1987c3967998818764c9d4238add5f3aa7c'` |
| [`clearai-dsh`](https://github.com/Clearailhc/clearai-dsh) | `0.5.6` | 证据驱动研究与领域本体预置 | `"$DSH_CLI" plugin --profile desktop add 'clearai-dsh@0.5.6'` |
| [`dsh-purge-community`](https://github.com/kingcharleslzy-ai/dsh-purge) | `1.6.38` | 修改官方 App runtime/CLI；仅记录已安装状态，不属于 D1 推荐配置 | `"$DSH_CLI" plugin --profile desktop add 'https://github.com/kingcharleslzy-ai/dsh-purge/releases/download/v1.6.38/dsh-purge-community-1.6.38.tgz'` |
| [`dsh-session-prefix`](https://github.com/john-walks-slow/dsh-session-prefix) | `0.1.0` | 会话阶段前缀；Jev/Agent 工具路径需独立配置 | `"$DSH_CLI" plugin --profile desktop add 'dsh-session-prefix@0.1.0'` |
| [`@dsh-jev/plugin`](https://github.com/luobosibing2/dsh-jev-plugin) | `0.1.0` | Jev 决策集成；需独立配置，不默认启用能力 | `"$DSH_CLI" plugin --profile desktop add 'github:luobosibing2/dsh-jev-plugin#c54e071e99eb839749b3991d29ede9ca20e275f6'` |
| [`dsh-univer-office`](https://github.com/dream-num/dsh-univer-office) | `0.3.7` | Univer 文档预览与协作工作区 | `"$DSH_CLI" plugin --profile desktop add 'dsh-univer-office@0.3.7'` |
| [`dsh-research-report`](https://github.com/PerryLink/dsh-research-report) | `0.3.29` | 带证据账本和验证信息的研究报告 | `"$DSH_CLI" plugin --profile desktop add 'dsh-research-report@0.3.29'` |
| [`dsh-industry-research`](https://github.com/PerryLink/dsh-industry-research) | `0.3.23` | 行业/公司研究工具与方法技能 | `"$DSH_CLI" plugin --profile desktop add 'dsh-industry-research@0.3.23'` |

### 官方内置：16 项

这些条目随已安装官方 App/运行环境提供；在「插件 → 已安装」或官方内置插件设置中按需启用。基础运行环境和原生 Web 界面不需要重复安装。下表官方版本按已发布 App 基线列出；不会用这些开关复制他人的账号或配置。

| 插件 | 快照版本 | 用途 | 安装或启用方式 |
|---|---|---|---|
| [`@deepseek-ai/dsh-base`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 基础运行环境 | 随官方 App 提供 |
| [`@deepseek-ai/dsh-web-app`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 原生 Web 界面 | 随官方 App 提供 |
| [`@deepseek-ai/dsh-experimental-agent-team-profile`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | Agent 团队 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-voice-input-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 语音输入 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-inspector-profile`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 检查器 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-auto-review`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 自动审批 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-cot-translation-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 思考翻译 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-tool-worktree`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | Git worktree 工具 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-terminal-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 终端 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-subagent-codex`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | Codex 子智能体 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-subagent-claude-code`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | Claude Code 子智能体 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-ralph-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | Ralph 循环 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-plugin-market-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 插件市场 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-session-search`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 会话搜索 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-session-titles-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 会话标题 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
| [`@deepseek-ai/dsh-experimental-badge-skill-bundle`](https://github.com/deepseek-ai/deepseek-harness) | `0.2.1-rc.2` | 技能徽章 | 在官方插件设置中启用；按需完成其登录/依赖配置 |
<!-- SOLAR-INSTALLED-PLUGINS:END -->

## 我们开发和修改的插件怎么用

| 插件 | 操作入口与步骤 | 何时会真正执行 |
|---|---|---|
| 模型交接 | 在模型选择器切换原生模型；选择携带任务或「取消交接，空白开始」，检查预览。进入 Web/洞察直接开始算子任务；返回原生模型时，分别决定是否携带算子结果与此前上下文。 | 短任务直接携带；长任务生成摘要可能使用 Luna 额度。新问题在发送后执行。 |
| 原生协同 | 对话顶部「协同模式」选「普通」或「智能协同」；设置中的「协同诊断」可只读看注册与任务状态。 | 模式切换不调用模型；派发任务或带额度标识的测试会执行。 |
| Resident | 与原生协同配合，先完成 Codex/Claude 原生产品登录；Agent 用 `solar_resident` 查看任务，用 `solar_coordinate` 提交明确的任务图。 | 提交/恢复是执行动作；检查不重复派发。提交回执不是最终成功。 |
| 执行流程 | 对话「执行流程」选择来源或已有草稿；编辑阶段、依赖和属性，点「保存草稿」，切走重开核对。普通聊天不需要创建流程。 | 编辑保存不运行；「按此草稿再次执行」「继续原执行」可能使用额度。 |
| 网页与洞察 | 设置 →「网页与洞察」，分别保存两页设置；「刷新可用模型」只读目录。任务在模型选择器选「ChatGPT 网页算子」或「洞察分析」。先准备 Ego Lite 和相应网站登录。 | 发送问题/执行研究阶段才调用网站。当前实验版的未知提交结果不要自动重发。 |
| Prime RLM | 对话「Prime RLM」或设置 →「Prime RLM」看运行时；Agent 按指南调用 `solar_rlm_run`，指定工作目录、任务、请求数和时间上限，用 `solar_rlm_inspect` 查看。 | 启动/继续任务会用当前提供商额度；本地自检不代表推理效果。 |
| billion-context | 安装 Solar 维护包后在 `bili设置` 查看配置；按该项目说明使用压缩工具，避免重复启用另一条压缩集成。 | 真实模型请求可能涉及压缩；不保证固定节省比例。 |
| Dream Skin | 设置 →「Theme / 外观」配置皮肤与壁纸；高级壁纸选择链接列表或本地文件夹图源，启用轮换并按需点「立即换下一张」。图片由使用者自己提供。 | 主题、图片和本地目录读取不使用模型额度。 |

完整依赖、恢复方式和验收限制见[使用指南](docs/curated-plugin-usage.md)。

## Agent 执行约定

1. 阅读[包目录](distribution/plugins/catalog.json)、[安装说明](docs/curated-plugin-installation.md)和[使用指南](docs/curated-plugin-usage.md)，确认平台、宿主版本、用户选择与所需外部依赖。
2. 固定仓库提交；下载并校验完整包及许可证。只安装指定的包，不默认安装整套社区插件，不复制作者本机配置或认证。
3. 在 App/Host 退出且 Resident 无工作时，备份最新 profile，经官方 CLI 安装。未知安装效果先核对原回执，不盲目重跑命令。
4. 记录源码提交、包 SHA-256、CLI 结果、安装文件身份和启动/UI 检查。用户尚未授权时，不发送模型消息、不点连接测试、执行或重试。
5. 分别报告「文件已下载」「CLI 安装完成」「插件入口可用」「真实执行通过」。不能把前一项代替后一项。

## 开发与来源

本项目的默认分支为 `v4`；旧 DSH 3.x 源码与历史分支保留但已冻结。功能源码位于独立开发分支的 `incubator/`；公开验证包位于 `distribution/plugins/`，**不把这些预览包冒充 `plugins/*` 的稳定市场 Release**。包目录给出各自的源码提交和来源仓库。

- [项目约定](AGENTS.md) · [原生插件契约](docs/native-plugins-contract.md) · [市场指南](docs/market-guide.md)
- [固定宿主基线](upstream.json)：`@deepseek-ai/dsh@0.2.1-rc.2` / Cordis `4.0.5`。这不是“上游最新版”的声明。
- 官方 `deepseek-ai/deepseek-harness` 只供参考，本项目不修改官方 App，也不向官方上游自动提交代码。
- 下方稳定市场列表由发布 tag 自动生成；预览包的直接下载不需要、也不会自动创建市场索引、Pages 或 npm 发布。

## Published plugins

<!-- SOLAR-PUBLISHED-PLUGINS:START -->
No stable Solar market release has been published. Preview tarballs and maintained forks are available in [the curated package directory](distribution/plugins/); they are separate from market publication.
<!-- SOLAR-PUBLISHED-PLUGINS:END -->
