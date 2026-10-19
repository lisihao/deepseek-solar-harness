# DeepSeek Solar Harness V4

DSH V4 uses the official DeepSeek Harness Desktop application unchanged together with an independent collection of Solar plugins. V4 has no core of its own: it does not vendor, fork, build, re-sign, or otherwise modify the official application.

V4 is a personal project hosted publicly at `lisihao/deepseek-solar-harness`. Official `deepseek-ai/deepseek-harness` upstream is read-only for reference and updates: this project does not push, submit PRs, or merge changes into it. V4 feature PRs belong in the personal repository.

## Current state

No Solar plugin has been published. No market index or installation URL exists. Native collaboration and native Resident are under authorized development; RLM will be a separate task. Build/test tooling is local; no recurring automation has been activated.

The `v4` branch is the V4 repository entry point. It contains the V4 rules, documentation and pinned upstream identity. Native plugin development adds candidates under `incubator/`. GitHub readback confirmed `v4` as the default branch on 2026-10-19.

## Upstream baseline

The recorded baseline is [`@deepseek-ai/dsh@0.2.1-rc.2`](upstream.json), with tag `dsh-v0.2.1-rc.2` and commit `687f282e8625c6b8d11ff58211a90524be2e4317`. This record is not a claim that the baseline is the current upstream release or that it has passed installed-app acceptance.

## 官方 App 插件清单与使用建议

**核对日期：2026-10-19（Asia/Shanghai）。官方 DeepSeek Harness App 与其内置 Harness 版本均为 `0.2.1-rc.2`，profile 为 `desktop`。** 实际包版本、profile 声明与运行中 App 的“插件 → 已安装”页面已交叉核对：**15 个第三方插件、14 个官方可选插件，29 个开关均为开启**；另有 2 个官方基础 bundle，共 31 个配置 bundle。[机器可读清单](docs/installed-plugins-2026-10-19.json)保留完整包名与版本。

这里的推荐按用途和作者说明提出，是选用建议。**已安装、界面开关开启，不等于每个功能都已运行验证。** 本轮没有模型请求、网页任务、账号验证、安装、升级、启停或重启，也不证明 V4 独立数据目录已完成验收。版本是本机快照，不代表各项目最新版。这些插件由各自作者维护，不是本仓库发布的 Solar 插件。

### 建议从哪些开始

- **日常观察与管理**：`dshmarket` 找插件，`dsh-context` 看上下文，`dsh-cost-meter` 看用量与费用估算。
- **开发与审查**：按已有账号选择官方 Codex / Claude Code 子智能体，再按需使用 Code Review、Git Graph；需要在 DSH 主对话中使用 ChatGPT 订阅模型时，选择 `dsh-codex-subscription`。
- **可视化与个性化**：按任务选 ThoughtDAG 或 Archify；主题、人设和 Agent 预置按个人偏好选择。长期记忆、浏览器自动化和 LoopX 则先确认各自依赖与用途。

### 第三方插件：15 项

下列版本均来自实际安装包；开关均已在 App 中观察为开启。每项链接指向作者项目。

| 插件包 | 本机版本 | 用途 | 选用建议 |
|---|---|---|---|
| [`dshmarket`](https://github.com/dsh-market/dsh-market) | `1.66.37` | 插件市场 | 浏览、搜索和安装社区插件。推荐作为发现入口；它不是 Solar 插件市场。 |
| [`dsh-context`](https://github.com/bowenliang123/dsh-context) | `0.73.3` | 上下文洞察 | 查看上下文组成、变化和历史。推荐用于排查上下文占用；不代表已证明节省 token。 |
| [`dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter) | `1.9.11` | 费用计量 | 查看 token、费用估算和计价时段。推荐辅助观察用量；估算不等于供应商账单。 |
| [`dsh-codex-subscription`](https://github.com/WSL043/dsh-codex-subscription) | `3.1.1` | Codex 订阅 | 有合适 ChatGPT / Codex 订阅时推荐，用于在 DSH 主对话选择订阅模型；与官方 Codex 子智能体不同。 |
| [`@feng0531/dsh-code-review`](https://github.com/f-e-n-g-0531/dsh-code-review) | `0.84.0` | Code Review | 需要 Git / SVN 只读代码审查时推荐；审查结论仍需核对。 |
| [`@linxin666/dsh-client-ui-git-graph`](https://github.com/zhu1090093659/dsh-web) | `0.4.7` | Git Graph | 按需查看分支关系和 Git 图；其中的实际 Git 操作与只读浏览要分开判断。 |
| [`dsh-thoughtdag`](https://github.com/chenxiachan/thoughtdag/tree/main/dsh) | `0.5.19` | ThoughtDAG | 按需把会话组织为可编辑思维图，适合梳理复杂讨论。 |
| [`@tt-a1i/archify-dsh`](https://github.com/tt-a1i/archify/tree/main/integrations/deepseek-harness) | `1.0.0` | Archify | 按需生成仓库架构图。安装版说明仅承诺在宿主 0.1.2-rc.1 上的验收，本机 0.2.1-rc.2 的生成功能本轮未测试。 |
| [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://github.com/Tencent/BrowserSkill/tree/main/packages/dsh-plugin-browserskill) | `0.3.3` | BrowserSkill | 有浏览器自动化需求时选用；本轮未执行网页任务。 |
| [`@vectorize-io/hindsight-coding-agents`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | `0.8.1` | Hindsight | 需要长期项目记忆时选用。先确认记忆后端和历史摄取范围；作者说明包含后台摄取。 |
| [`@linxin666/dsh-liangshen`](https://github.com/zhu1090093659/dsh-web) | `0.4.7` | 梁神模式 | 按需选择 Agent 预置与工具呈现方式；本轮未验证其对任务质量或速度的影响。 |
| [`dsh-dream-skin`](https://github.com/RevolutionLA/dsh-dream-skin) | `10.16.0` | Dream Skin | 按个人喜好使用主题、壁纸和强调色；当前宿主上的设置持久化未作功能验收。 |
| [`dsh-persona-dafeiyu`](https://github.com/huaizhuanghub/dsh-persona-dafeiyu) | `0.4.1` | 大肥鱼人设 | 按需选择或导入对话人设；不把人设变化视为执行能力提升。 |
| [`dsh-loopx-plugin`](https://github.com/loopx-project/loopx/tree/main/packages/dsh-loopx-plugin) | `0.1.1-beta.6` | LoopX | 进阶试用：目标驱动、同会话循环和 GoalBar。当前安装存在 0.2.1-rc.2 兼容性豁免，不作为默认入门组合。 |
| [`dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login) | `1.0.3` | DeepSeek 网页接入 | 进阶试用：非官方网页模型接入。依赖网页登录与接口变化，本轮未测试，不作为默认 API 接入替代。 |

LoopX 的 `0.1.1-beta.6` 安装说明以 DSH `0.2.0-rc.2` 为验证目标，本机为 `0.2.1-rc.2` 保存了兼容性豁免。这只说明当前安装被允许，不是跨版本兼容证明；本次没有新增或重放该豁免。Archify 的适配包版本 `1.0.0` 与其内含 Skill 版本不同，表中记录的是插件包版本。

### 官方可选插件：14 项

以下包均为 `0.2.1-rc.2`，开关均为开启。除两个子智能体包外，其余 12 项的包名带 `experimental`，应按实验性功能选用；本清单不建议为凑齐组合而全部开启。

| 功能 | 包名 | 用途 |
|---|---|---|
| Codex 子智能体 | `@deepseek-ai/dsh-subagent-codex` | 委派一个独立 Codex 任务；使用原生认证和设置。 |
| Claude Code 子智能体 | `@deepseek-ai/dsh-subagent-claude-code` | 委派一个独立 Claude Code 任务；使用原生认证和设置。 |
| 智能体团队 | `@deepseek-ai/dsh-experimental-agent-team-profile` | 团队协作、成员与共享任务看板。 |
| 语音输入 | `@deepseek-ai/dsh-experimental-voice-input-bundle` | 本机语音转写；依赖准备情况本轮未测试。 |
| 自动授权审查 | `@deepseek-ai/dsh-experimental-auto-review` | 由模型审查工具调用授权；不在本轮改变权限模式。 |
| 开发者工具 | `@deepseek-ai/dsh-experimental-inspector-profile` | 查看会话与运行调试信息。 |
| Git 工作树 | `@deepseek-ai/dsh-experimental-tool-worktree` | 创建分支与工作树以隔离任务。 |
| 思考过程机器翻译 | `@deepseek-ai/dsh-experimental-cot-translation-bundle` | 将展开的思考内容发送给所选服务进行翻译。 |
| 持久终端 | `@deepseek-ai/dsh-experimental-terminal-bundle` | 在多次工具调用间保留 shell 进程。 |
| 会话搜索 | `@deepseek-ai/dsh-experimental-session-search` | 搜索和读取当前工作区的历史会话。 |
| 随对话更新的标题 | `@deepseek-ai/dsh-experimental-session-titles-bundle` | 随新用户提示更新会话标题。 |
| DSH 徽章技能 | `@deepseek-ai/dsh-experimental-badge-skill-bundle` | 为文档等产出添加 DSH 徽章。 |
| Ralph 循环 | `@deepseek-ai/dsh-experimental-ralph-bundle` | 执行用户明确要求的循环工作。 |
| 自定义插件市场 | `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 在“发现”页读取用户添加的市场索引。 |

两个子智能体分别使用 [Codex 原生认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-codex/README.md)和 [Claude Code 原生认证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-claude-code/README.md)，不是由该插件新建登录状态；账号是否可用、额度是否足够，本轮均未查询。它们执行独立的单次任务，不代表已实现原生会话持久接续。`dsh-codex-subscription` 则提供 DSH 主模型接入，二者可以按用途分别选择。

另有两个官方基础 bundle：`@deepseek-ai/dsh-base@0.2.1-rc.2` 与 `@deepseek-ai/dsh-web-app@0.2.1-rc.2`，分别构成基础运行环境和 Web 界面，不计入上面 29 个可选开关。

### 如何按需安装

在官方 App 打开 **插件 → 添加插件**，使用表中的准确包名与版本，例如 `dsh-context@0.73.3` 或 `dsh-codex-subscription@3.1.1`；先查看作者说明与当前宿主要求，再按 App 提示完成操作。已经内置的官方功能在插件页按需启用即可，不必照抄 CLI 的 `web` profile 安装命令。LoopX 不在这里提供绕过兼容性检查的安装命令；Hindsight 使用前应确认本地或远程记忆后端及历史摄取范围。

## DSH 3.x archive and freeze

DSH 3.x remains in the same repository as preserved legacy history: [`solar`](https://github.com/lisihao/deepseek-solar-harness/tree/solar), [`master`](https://github.com/lisihao/deepseek-solar-harness/tree/master), [tags](https://github.com/lisihao/deepseek-solar-harness/tags), and [Releases](https://github.com/lisihao/deepseek-solar-harness/releases). All existing branches, pull requests, tags, and Releases remain retained. The 27 additional archive branches have been uploaded and their commit identities verified. DSH 3.x development is frozen. See the [source archive and known verification limits](docs/legacy-source-archive.md).

V4 must not copy or move DSH 3.x source into this branch. A future plugin may assess a legacy capability only through the V4 plugin rules and an explicitly authorized migration plan.

## Documentation

- [V4 operating rules](AGENTS.md)
- [Repository transition and preservation record](docs/repo-reorganization.md)
- [Three-loop development workflow](docs/development-loops.md)
- [DSH 3.x extraction candidates](docs/extraction-candidates.md)
- [DSH Codex Subscription integration and migration plan](docs/integrations/dsh-codex-subscription.md)
- [Native plugins: ownership and acceptance](docs/native-plugins-contract.md)
- [Native plugin source verification](docs/native-plugins-verification.md)
- [Native Resident development candidate](incubator/native-resident/README.md)

Unreleased plugin work belongs in `incubator/<name>/`; only an authorized first release moves it to `plugins/<name>/`. Root workspace globs exclude these candidates from the market. Run `pnpm install --ignore-scripts`, then `pnpm check` for local source verification; scratch-profile tests require package-registry access and never call a model.

## Published plugins

<!-- SOLAR-PUBLISHED-PLUGINS:START -->
No Solar plugin has been published. The plugins under `incubator/` are development candidates.
<!-- SOLAR-PUBLISHED-PLUGINS:END -->
