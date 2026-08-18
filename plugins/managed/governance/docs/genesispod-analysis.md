# GenesisPod AI 工程治理分析

分析基线：`/Users/sihaoli/Projects/GenesisPod`，分支 `codex/insight-migration-baseline`，基线提交 `32acc03c9`。本次仅分析，没有修改 GenesisPod。

## 1. 资产全景

| 资产 | 数量/入口 | 作用 |
| --- | ---: | --- |
| AI 主指令 | `.claude/CLAUDE.md`（634 行） | 项目语境、架构层级、行为红线和交付要求 |
| 详细标准 | 27 份，`.claude/standards/` | 目录、命名、代码、API、数据、测试、Git、安全、脚本、依赖、UI、插件等 |
| 专职 Agent | 14 份，`.claude/agents/` | PM、开发、测试、审查、架构、安全、脚本、文档、合并等职责 |
| 操作命令 | 17 份，`.claude/commands/` | verify、TDD、review、debug、deploy、arch guard 等流程 |
| 上述 Markdown | 22,941 行 | 多年工程经验的主要 AI 化载体 |
| 架构契约测试 | 41 个 spec | 分层、facade、能力唯一性、运行契约、耐久性等 |
| GitHub Actions | 5 个 workflow | CI、部署、gitleaks、smoke、CLA |
| 工程脚本 | 根目录 86 + backend 50 | 审计、生成、迁移、发布、诊断和验证 |

## 2. 已形成的方法论

### 2.1 Agent 行为治理

- 分析先行，必须读取真实源码后判断。
- 限定任务范围，不顺手修改无关文件。
- 架构决策、依赖和接口变更需要显式确认。
- 暴露需求多义性，不静默替用户选择。
- 交付必须运行验证并报告真实状态。
- PM、Coder、Tester、Reviewer、Architect、Security Auditor 等角色分工明确。

### 2.2 架构治理

- AI 系统采用 `L4 -> L3 -> L2.5 -> L2 -> L1` 单向依赖。
- `ai-app` 通过 facade/registry 使用底层能力，禁止穿透内部路径。
- MECE、唯一能力源、标准术语和 bounded capability 被持续固化。
- ESLint、架构 spec、pre-push、CI `arch-boundary` 构成多层控制。
- 基础层文件治理、插件系统、Open API、业务团队框架均有专门契约。

### 2.3 代码与质量治理

- TypeScript lint、type-check、格式化、单元/集成测试和 production build。
- backend CI 使用完整测试和 coverage 阈值；frontend CI 运行 coverage。
- 完整 NestJS DI 图 boot smoke 避免 mock 单测遗漏启动崩溃。
- capability index、facade boundary、脚本布局、反模式审计防止结构漂移。
- 大文件增长棘轮、UI canonical 复用、design token、i18n 和 mission-detail 审计。

### 2.4 安全与交付治理

- 密钥、输入、注入、XSS/CSRF、认证授权、依赖安全均有规范。
- 独立 gitleaks workflow 扫描历史和变更。
- Conventional Commits、lint-staged、pre-commit/pre-push/commit-msg hooks。
- CI 使用 `ci-status` 聚合 lint、测试、build、quality、architecture、UI、boot、capability jobs。
- 生产 smoke workflow 定时检查健康、端点和响应时间。

## 3. “声明—控制—门禁”映射

| 规则族 | 文档 | 本地控制 | CI 控制 | 当前判断 |
| --- | --- | --- | --- | --- |
| AI 分层/facade | CLAUDE + 16/17 等标准 | ESLint + 41 个 architecture specs | `arch-boundary`, `quality` | enforced，仍含 honor-only 细则 |
| 类型/代码风格 | 04/07 等标准 | lint-staged、lint、type-check | `lint` | enforced |
| 测试/覆盖率 | 07 testing | quick/full Jest/Vitest | backend/frontend coverage | enforced in CI；本地别名不等价 |
| UI 复用 | 标准 22 | pre-push 多项审计 | `ui-discipline` | 部分差异，见缺口 |
| 脚本治理 | 标准 12 | audit scripts | `ui-discipline` job 内执行 | enforced for current CI paths |
| 密钥泄露 | 标准 10 | 文件名检查有限 | 独立 gitleaks | remote enforced 取决于分支保护 |
| Agent 行为 | CLAUDE + agents/commands | checklist/人工 | N/A | 大量 honor-only |
| 运行健康 | deploy/smoke 文档 | 手工/脚本 | 定时 smoke | runtime-only，不是 PR merge gate |

## 4. 关键缺口与漂移

### P0/P1：会影响“是否真的阻断”

1. **Husky 文件模式不是可执行模式**：`.husky/pre-commit`、`pre-push`、`commit-msg` 在 Git 索引均为 `100644`。不同安装/平台可能直接忽略，本地门禁不能当作可靠证据。
2. **治理文件被主 CI 忽略**：`.github/workflows/ci.yml` 对 `.claude/**`、Markdown、docs 设置 `paths-ignore`。仅修改核心治理文档时，主 CI 不运行，规则漂移缺少自验证。
3. **不存在唯一的本地 CI 等价命令**：`validate`、`verify:full`、`verify:ci-local`、pre-push 和 CI 覆盖集合不同。`verify:full` 未覆盖 architecture、boot、UI、capability、facade、secret 等门禁。
4. **`verify:changed` 漏掉未跟踪文件**，并且只跑部分 type/test；不包含 lint、architecture、UI、build 和 CI full tests，不能作为完成证明。
5. **本地 UI 门禁可被 `SKIP_UI_AUDIT=1` 绕过**，且 `audit:ui-tokens` 在本地被描述为硬门，但 CI 注释明确为 warn-only/未接入，语义不一致。
6. **依赖安全检查 fail-open 风险**：CI 中 `npm audit ... || true`，解析失败又回退到 0；网络或输出异常可能被解释为“无 critical”。

### P2：一致性和可维护性

7. **主指令存在过期描述**：`.claude/CLAUDE.md` 仍写覆盖率“待接入 CI”，而当前 CI 已通过 `test:ci --coverage` 强制 backend 阈值。AI 会读取到错误现状。
8. **规则总量巨大且重复入口多**：约 2.3 万行指令分散在 standards/agents/commands，缺少机器可读的适用范围与稳定 rule ID，Agent 很难确定本次必须读哪些。
9. **honor-only 与 enforced 混排**：主指令虽局部标出 honor-only，但没有统一机器清单、负责人和升级计划。
10. **branch protection 不在仓库内可证**：`ci-status` 与 gitleaks 是否为 required checks 取决于 GitHub 外部设置；仅看到 workflow 不能证明合并一定被阻断。
11. **pre-push 依赖 `origin/main`**：远端引用缺失或陈旧会影响 changed-test 和 god-class 差异范围，脚本没有统一 freshness 契约。
12. **基线/allowlist 分散**：UI、i18n、capability 等都有例外机制，但缺少统一 owner/reason/expiry schema。

## 5. 抽取后的优化

本项目没有复制 2.3 万行规则，也不靠更长的提示词约束 Agent，而是抽出七个稳定原语并用代码执行：

1. **Authority**：发现指令并明确优先级。
2. **Applicability**：从全部改动类型推导治理范围。
3. **Control**：把规则关联到可执行命令。
4. **Transition**：区分 edit、commit、push、merge、deploy。
5. **Exception**：统一原因、负责人和过期时间。
6. **Evidence**：保存命令、退出码、耗时、跳过与外部状态。
7. **Attestation**：把通过结果绑定到 Profile、HEAD、改动集合和文件字节，改动后立即失效。

GenesisPod 的特殊架构、组件和脚本保留在版本化 Profile；通用 Skill 只规定如何发现、执行、验证和举证。

## 6. 建议的 GenesisPod 后续治理任务

这些问题未在本次直接修改 GenesisPod，建议以后作为独立 PR 处理：

1. 修复并验证 Husky executable bit，增加 CI 自检。
2. 新增单一 `governance:verify` 命令，作为本地 full gate 与 CI 编排 SSOT。
3. 给治理文档变更新增轻量 governance CI，而不是整体 paths-ignore。
4. 让 changed detector 包含 untracked/renames/branch commits，并输出选门理由。
5. 统一 bypass/baseline/allowlist 的 owner、reason、expiry 和审计。
6. 修正文档漂移，生成 rule catalog，标注 honor-only/available-only/enforced。
7. 让 dependency audit 在工具/网络异常时 fail-closed 或显式 unavailable。
8. 用 API 或 IaC 留存 required-check/branch-protection 证据。
