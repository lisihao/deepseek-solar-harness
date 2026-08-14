# Agent Development Governance

把团队长期积累的软件架构、工程规则、质量门禁和交付证据转化为 Codex、Claude Code 及后续 Coding Agent 可共同执行的通用治理 Skill。

GenesisPod 是第一个参考实现，不是通用内核的硬编码前提。

## 架构

```text
治理内核（稳定）
├── 规则发现：项目级 / 目录级 / Agent 级指令
├── 范围判定：未暂存 / 已暂存 / 未跟踪 / 分支提交
├── 门禁编排：quick / full / runtime
├── 执行语义：参数数组、超时、退出码、fail-closed
└── 证据模型：命令、结果、耗时、跳过原因、外部 CI

扩展层（持续演进）
├── 项目 Profile：GenesisPod、未来项目
├── 技术栈控制器：TypeScript、Python、移动端、基础设施
├── 领域规则包：架构、安全、UI、数据、发布、可观测性
└── Agent 适配：Codex、Claude Code、未来 Coding Agent
```

## 目录

| 路径 | 用途 |
| --- | --- |
| `docs/genesispod-analysis.md` | GenesisPod 规则、脚本、门禁与缺口的证据分析 |
| `docs/extension-architecture.md` | 版本、Profile 和控制器的扩展契约 |
| `scripts/governance.py` | Code Harness 核心；不依赖 Agent 自觉执行规则 |
| `scripts/export_bundle.py` | 将核心和项目 Profile 导出为可由 CI 独立验证的版本化 bundle |
| `skill/agent-development-governance/` | Codex 与 Claude Code 共用的薄适配层 |
| `integrations/` | Hook/CI 的强制接线模板 |
| `tests/` | 治理执行器的回归测试 |

## 使用

```bash
SKILL_DIR=/Users/sihaoli/Projects/agent-development-governance/skill/agent-development-governance

python3 "$SKILL_DIR/scripts/governance.py" audit \
  --project /Users/sihaoli/Projects/GenesisPod

python3 "$SKILL_DIR/scripts/governance.py" plan \
  --project /Users/sihaoli/Projects/GenesisPod \
  --scope auto --level full

python3 "$SKILL_DIR/scripts/governance.py" verify \
  --project /Users/sihaoli/Projects/GenesisPod \
  --scope auto --level full \
  --report /tmp/genesispod-governance-attestation.json

python3 "$SKILL_DIR/scripts/governance.py" attest \
  --project /Users/sihaoli/Projects/GenesisPod \
  --report /tmp/genesispod-governance-attestation.json \
  --require-level full
```

在 Agent 中可直接说：

- Codex：`使用 $agent-development-governance 完成本次修改并给出全部门禁证据。`
- Claude Code：`使用 /agent-development-governance 审查并验证当前改动。`

## 原则

1. 项目原生规则和 CI 是权威来源，Code Harness 负责发现、编排和留证据；Skill 只负责让 Agent 调用它。
2. 文档规则、可用脚本、已接线门禁必须区分，不能把“写了”当成“执行了”。
3. 不通过修改测试、基线、白名单或 bypass 开关换取绿色结果。
4. 本地验证、远端 CI、分支保护和运行态验证分别举证。
5. 通用内核保持稳定，业务差异通过版本化 Profile 扩展。

## 导出到项目

```bash
python3 scripts/export_bundle.py \
  --project /path/to/project \
  --profile /path/to/project-profile.json
```

导出内容位于项目的 `tools/agent-development-governance/` 与 `.agent-governance/profile.json`。Manifest 记录中央版本、源提交和每个文件的 SHA-256；项目执行 `audit` 时会拒绝缺失或漂移的 bundle。
