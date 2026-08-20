# DSH — DeepSeek Solar Harness

[English](README.md) | 中文

**DeepSeek Harness 的 Solar 发行版：以 macOS Desktop 应用为产品形态，目标是可扩展的 All-in-One AI 工作台。**

DeepSeek-Solar-Harness（`DSH`）是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的下游产品。它保留上游的插件架构与 agent runtime，同时拥有独立的 Solar 集成分支、Desktop 产品、受管插件、发布身份和工程治理。产品目前只支持 macOS；其他操作系统不在已验收的产品合同内。

本仓库是 Solar 核心、Desktop shell 和 Solar 维护插件的完整开发源码。它不代表 DeepSeek AI 的官方发行版，Solar 改动也不会回馈到任何上游仓库。

## 产品目标

DSH 的目标是让一个本地应用成为对话、工具、会话、记忆、上下文、coding agent、协作、远程界面和可观测任务执行的日常控制中心。产品在增加能力时保护以下五项性质：

1. **模型能力。** 打包内的 Anchored Standard preset 让主 agent 与 delegated worker 首轮只看到 `bash` 和 `str_replace_editor`，随后按需公开其他工具。这样可以减少首轮 tool schema 压力，同时不删除后续能力。
2. **连续性。** Session 历史、runtime 所有权、记忆、任务进度和 resume 行为必须跨越普通 UI 导航与进程边界继续存在，并且不能悄悄改变所选执行路径。
3. **可组合性。** 核心行为、Desktop 呈现和产品功能保持为 Cordis 插件或显式产品输入。任何功能都不能依赖对生成运行态的未记录补丁。
4. **可复现性。** 每份 Solar 自有源码输入都有仓库路径、接受版本、许可证记录、原生测试和可评审历史。已安装应用和用户 profile 是输出，不是源码。
5. **受控演进。** 上游变更先作为候选被发现，再根据 Solar 合同完成资格审查；只有冲突、兼容性、行为、打包和治理证据都被接受后才会合并。

## 产品特性

- macOS Desktop 应用，提供 compatibility 与 advanced 两种呈现模式、原生生命周期集成、隔离 profile、内置 DSH terminal、更新发现和显式产品版本显示。
- 在受保护 `solar` 集成线上开发的 DeepSeek Harness agent、模型、工具、Session、Web、sandbox、workflow 与插件基础。
- 已接受的 Anchored Standard 产品 preset 使用双工具首轮 bootstrap，delegated AgentTeams worker 也遵循该规则，后续能力按需发现。
- Smart 与 resident operator 路径、AgentTeams 协作、受管记忆、Luna 视觉桥接、Web billing 和受管 Web UI 集合。
- 仓库自有 Code-as-Harness 完成权威：根据待交付差异选择原生命令、记录 attestation 证据，并在治理接线缺失或陈旧时 fail closed。
- 核心、Desktop 与受管插件可在同一源码仓中协同修改，同时每个组件保留自己的包管理器与测试合同。

## 架构

DSH 保留上游 Cordis 原则：能力通过插件、service、event 和 profile 配置组合。Solar 产品在这些运行机制外增加受控的仓库与发行层。

```text
DeepSeek-Solar-Harness
├── Core Harness (pnpm workspace)
│   ├── agents, models, tools, sessions, workflows, sandboxes
│   └── Web host/client and Cordis plugin runtime
├── products/desktop (Yarn workspace)
│   └── Electron shell, profiles, native lifecycle, packaging, product UI
├── plugins/managed
│   ├── governance (the user-created Code-as-Harness project)
│   ├── agent-teams, luna-vision-bridge, memory-evolve
│   └── web-billing, web-ui
├── distribution
│   └── product identity, Desktop version, tag contract, upstream records
└── protected solar branch
    └── reviewed task branches + CI + Code-as-Harness attestation
```

核心保留在仓库根目录，使其 pnpm workspace 继续有效。Desktop 位于 [`products/desktop`](products/desktop)，它是独立 Yarn workspace，禁止再包含一份 Harness checkout。Solar 自有组件位于 [`plugins/managed`](plugins/managed)；[`plugins/registry.yaml`](plugins/registry.yaml) 是其源码、版本、许可证与测试的机器可读注册表。产品与上游元数据位于 [`distribution`](distribution)。

Desktop 在 Yarn 构建期间安装已接受的 sealed package 输入，并通过 [`products/desktop/dsh-plugin-desktop/vendor/manifest.json`](products/desktop/dsh-plugin-desktop/vendor/manifest.json) 把每个 sealed package 映射回仓库中已跟踪的源码包。`yarn verify:vendor` 会提取每个归档的 manifest，把所有非生成文件与已跟踪源码逐字节比较，并拒绝未跟踪、缺失、陈旧或名称/版本不一致的输入。因此，fresh clone 已包含默认 Desktop 应用中每个 sealed package 的源码。

用户自行安装到 `~/.dsh` 的可选插件属于 profile 扩展，并非默认 Desktop 构建输入。未修改插件保持 external；只有 Solar 修改或打包插件时，才会携带来源与原生测试进入 [`plugins/managed`](plugins/managed)。个人 Remote Modules 的网页名称、URL 和中继端口同样只保存在本机 profile 设置中；公开应用只发布配置界面与空实例列表。

## 与上游项目的关系

| 对象 | 上游作用 | Solar 规则 |
| --- | --- | --- |
| DeepSeek Harness | Runtime 与插件架构来源 | 只读上游输入；Solar 改动保留在本仓库 |
| Desktop 祖先项目 | 产品 shell 设计来源 | 历史已导入；Solar 拥有当前 macOS 产品 |
| 外部插件 | 独立插件发行版 | 未修改时保持 external，并锁定接受版本 |
| 受管插件 | Solar 修改能力的上游或 fork 来源 | 在 `plugins/managed` 保留导入历史；绝不把 Solar 改动推送到上游 |
| Code-as-Harness | 用户在 Codex 中创建的 `agent-development-governance` 项目 | 精确权威导入 `plugins/managed/governance`；禁止替换为通用概念或同名项目 |

已接受源码版本属于数据，不属于说明性文字：请查看 [`distribution/upstreams.yaml`](distribution/upstreams.yaml) 与 [`plugins/registry.yaml`](plugins/registry.yaml)。校验器会拒绝缺失路径、非法 revision、缺失许可证证据、未绑定的 subtree 导入、嵌套 gitlink、不匹配的治理 bundle 或无效 Desktop 标签合同。

## 上游更新规则

“最新”表示发现到可供评估的新 revision，绝不表示自动接受。每次核心、Desktop 祖先或受管插件更新都遵循以下顺序：

1. **发现。** 记录当前接受 revision 与新的远端 revision，不修改 `solar`，也不改变运行中的安装。
2. **分级。** 纯元数据变更为 `R0`，隔离的叶插件变更为 `R1`，涉及 Session、agent loop、sandbox、persistence、默认组合或 Desktop packaging 的变更为 `R2`。
3. **机械导入。** 创建隔离候选 worktree，把上游移动与 Solar 适配分成独立 commit，保留上游历史并报告全部冲突。
4. **兼容性分析。** 比较 manifest、API、event 与 persistence vocabulary、profile 组合、工具暴露、Desktop package closure 和用户可见行为。
5. **资格审查。** 运行完整受影响组件套件、根产品合同、Code-as-Harness full verification 与 attestation，以及适用的 runtime 或 Desktop D00–D08 验收。
6. **评审与合并。** 向受保护 `solar` 提交 PR，列出旧/新 revision、冲突决策、证据、回滚点和未解决限制。`R2` 必须由人批准；自动化永不直接合并。
7. **记录接受。** 只有经过评审的 revision 才能更新 registry 或 upstream manifest。失败候选不会改变当前接受 revision。

本流程的权威决策是 [ADR-003](docs/architecture/adr-003-managed-plugin-lifecycle.md) 与 [ADR-004](docs/architecture/adr-004-upstream-qualification.md)。上游自动化可以创建候选分支或报告，但没有发布 package、向上游仓库 push 或修改已安装应用的权限。

## AI coding agent 开发规则

在本仓库中，**Code-as-Harness 只表示用户在 Codex 中创建的项目：`agent-development-governance`**。它的权威 skill 与实现导入在 [`plugins/managed/governance`](plugins/managed/governance)；仓库入口 skill [`.agents/skills/dsh-code-as-harness`](.agents/skills/dsh-code-as-harness/SKILL.md) 把该权威绑定到 DSH。导出的 runner 与 digest manifest 位于 [`tools/agent-development-governance`](tools/agent-development-governance)。

每个 AI coding agent 都必须遵循以下生命周期：

1. 解析 `/Users/sihaoli/Projects` 下的物理 Git 根，读取根与最近的 `AGENTS.md`，再读取仓库 Code-as-Harness skill 及其导入的权威 skill 与合同。
2. 基于受保护 `solar` 在隔离任务 worktree 工作；禁止把生成运行态、`/Applications/DSH Desktop.app` 或其他任务 worktree 当成源码修改。
3. 编辑前运行 strict audit 和完整的 change-aware plan，保留 dirty worktree 所有权与精确组件边界。
4. 实现最小而完整的改动；治理变更必须同时提供书面规则、可执行控制、接线、反例测试和 fail-closed 聚合。
5. 针对完整 `origin/solar` 差异运行组件原生检查，以及 Code-as-Harness full verification 与 attestation。
6. 提交已接受的字节，针对该精确 commit 重新验证，push 任务分支，再 fetch 并证明本地与远端 SHA 相等。
7. 报告本地与远端 SHA、PR 或 release URL、门禁证据、适用的运行态证据，以及全部 `warn`、`error` 或 `pending`。创建 PR 或 artifact 不等于完成。

从仓库根目录使用以下入口命令：

```sh
python3 tools/agent-development-governance/governance.py audit --project . --strict-warnings
python3 tools/agent-development-governance/governance.py plan --project . --scope auto --level full --changed-from origin/solar
python3 tools/agent-development-governance/governance.py verify --project . --scope auto --level full --changed-from origin/solar --report @git
python3 tools/agent-development-governance/governance.py attest --project . --report @git --require-level full
```

Desktop 改动还必须遵循 [`products/desktop/AGENTS.md`](products/desktop/AGENTS.md) 中完整的 D00–D08 协议。纯迁移、纯文档或纯治理改动不会安装或重启应用，并且必须显式说明该例外。

<a id="run"></a><a id="run-from-source"></a>

## 本地开发

前置条件是 macOS、Git、Node.js `22.19+` 或 `24+`，以及 Corepack。根依赖图与 Desktop 依赖图有意保持分离。

```sh
git clone https://github.com/lisihao/deepseek-solar-harness.git
cd deepseek-solar-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build

cd products/desktop
corepack yarn install --immutable
corepack yarn check
```

只有确实需要图形会话时才运行 Desktop 图形开发：

```sh
cd products/desktop
corepack yarn dev
```

受管组件使用 [`plugins/registry.yaml`](plugins/registry.yaml) 中记录的命令。不要把所有插件装入同一个包管理 workspace；组件 lockfile 与原生检查是其接受来源的一部分。

应用启动后，可在**设置 → 插件 → 远程模块**中配置个人网页。这些值写入本机 DSH profile，并有意排除在 Git、vendor 归档和公开产品默认值之外。

## 分支、提交与 Pull Request

- `solar` 是受保护的集成分支。全部改动从隔离 worktree 的任务分支进入；禁止直接 push、force push 或删除该分支。
- 使用 Conventional Commits，例如 `feat(desktop): ...`、`fix(memory-evolve): ...`、`sync(plugin/web-ui): ...` 或 `docs(readme): ...`。机械上游导入与 Solar 适配必须分成独立 commit。
- 非 Draft PR 以 `solar` 为目标，引用需求或 Issue，标明受影响组件与风险等级，并说明用户可见行为和兼容性影响。
- PR 为新增受管代码记录来源与许可证；为上游移动记录精确旧/新 revision；同时提供测试命令与结果、Code-as-Harness attestation、回滚信息和所有未解决限制。
- Desktop 产品或 package 改动必须包含分配的 Semantic Version、source/package/running version 一致性、D00–D08 证据、已安装应用备份路径、process/listener/HTTP 证明、远端 SHA 与 release URL。非应用交付任务要说明这些检查为何不适用。
- 必需 CI、conversation resolution、CODEOWNERS review 与 latest-push approval 必须通过。对于 `R2` 变更，编写代码的 agent 不能替代必需的人类批准。

## 发布身份

DSH Desktop 的版本独立于 DeepSeek Harness 和每个插件。Stable release 使用 annotated tag，并且必须精确匹配 `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$`，例如 `DSH-desktop-v2.6.0`。旧格式 `desktop-v2.4.3` 无效。

每次发布都要标识 Solar commit、Desktop version、接受的核心与受管插件 revision、测试与 attestation 证据、artifact checksum、支持平台和回滚目标。只生成 `dist/`、只看到 Electron process，或在没有 installed-version 验收时 push 标签，都不构成 Desktop 交付。

## 后续需求规划

| 阶段 | 必需结果 |
| --- | --- |
| 仓库基础 | 受保护 `solar`、monorepo 边界、保留的 Desktop/插件历史、来源注册表、Code-as-Harness skill 与可执行控制 |
| 上游监测 | 对核心、Desktop 祖先与全部受管插件进行定时只读发现；候选报告包含旧/新 revision 与风险等级 |
| 候选接入 | 可复现候选 worktree、机械导入 commit、Solar 适配 commit、冲突与接口变更报告 |
| 源码集成 | 只有同仓构建通过 closure、兼容性与回滚测试后，才替换临时公开或 sealed Desktop 输入 |
| 产品验收 | 自动覆盖 Session/resume、首轮工具暴露、memory/context、受管插件、Desktop 生命周期、packaging 与更新路径 |
| 发布自动化 | 签名并 notarize 的 macOS artifact、精确版本显示、checksum、release manifest、固定 GitHub Release、恢复与回滚证据 |
| 产品扩展 | 只有 macOS 合同持续为绿色后，才评估其他平台、插件市场治理、远程访问、可观测性和更丰富的 agent 协作 |

路线图工作必须继续保护前述目标。任何新功能只要削弱模型能力、Session 持久性、来源证明、发布身份或上游移动资格审查能力，就不能被接受。

## 源码与运行态边界

- 物理开发 checkout 与所有 linked worktree 位于 `/Users/sihaoli/Projects`。Documents 路径只用于兼容，禁止在其中存放物理 Git metadata、依赖或构建输出。
- `/Users/sihaoli/Library/Application Support/DeepSeek-Solar-Harness` 与 `/Applications/DSH Desktop.app` 是生成的运行部署。禁止把它们当成源码编辑，也禁止把其中改动复制回 Git。
- 凭据、profile、Session、memory、cache、`node_modules` 和构建 artifact 不进入源码导入。Fresh clone 必须能从已跟踪源码与声明输入重建产品。
- 本仓库不授予部署 Mac mini 的权限。后续远端部署必须拉取已标识的 GitHub Release，并独立验证。

## 文档与决策

请先阅读 [`AGENTS.md`](AGENTS.md) 了解 agent 常驻规则，阅读 [`docs/architecture.md`](docs/architecture.md) 了解上游 runtime map，并通过 Solar ADR 了解下游所有权：[产品身份](docs/architecture/adr-001-downstream-solar-product.md)、[monorepo](docs/architecture/adr-002-monorepo.md)、[受管插件](docs/architecture/adr-003-managed-plugin-lifecycle.md)、[上游资格审查](docs/architecture/adr-004-upstream-qualification.md)与 [AI agent 权威](docs/architecture/adr-005-ai-agent-authority.md)。

## 许可证

核心仓库使用 [MIT](LICENSE) 许可证。导入组件保留自己的许可证文件与声明；[`plugins/registry.yaml`](plugins/registry.yaml) 记录已接受证据。第三方运行时依赖见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
