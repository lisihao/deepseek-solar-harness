# 可持续扩展架构

## 1. 稳定边界

核心执行器只负责：Profile 加载、输入验证、Git 改动发现、scope 推导、gate 选择、无 shell 执行、超时、输出摘要和不可陈旧的 attestation。它不理解 NestJS、Next.js、GenesisPod 的 AI 分层或具体 UI 组件。

项目知识位于 Profile 和引用文档中。这样新增项目不会使既有项目规则互相污染。

远端 CI 不依赖开发机绝对路径。中央项目通过 `scripts/export_bundle.py` 生成版本化仓内副本和 SHA-256 manifest；项目 Profile 的 `harness_bundle.manifest` 让 `audit` 对漂移 fail-closed。

## 2. 版本策略

| 对象 | 当前版本 | 兼容策略 |
| --- | ---: | --- |
| Profile schema | `profile_version: 1` | 未知主版本 fail-closed |
| Skill | 目录名稳定 | 描述与工作流向后兼容，新增内容走 references/scripts |
| Gate ID | 项目内稳定 | 改名视为治理迁移，需保留映射说明 |
| Rule ID | 后续引入 | 建议 `<domain>.<topic>.<number>` |
| Attestation | `attestation_version: 1` | Profile、HEAD、改动路径或文件字节变化后失效 |

Profile 新增可选字段可保持 v1；改变字段语义或执行行为必须升主版本并提供迁移器。

## 3. 扩展点

### 项目 Profile

复制 `references/profile-template.json` 到项目的 `.agent-governance/profile.json`，定义 markers、instruction sources、scope rules、hooks、CI contracts 和 gates。

### 技术栈控制器

当前 gate 是通用 argv 数组。未来若需要增量测试图、容器运行、远端 CI 查询或 SARIF 聚合，应新增独立脚本子命令，并保持 Profile 只引用稳定入口。

### 规则目录

后续可加入机器可读 rule catalog：

```json
{
  "id": "architecture.facade.001",
  "level": "must",
  "scopes": ["backend"],
  "control_ids": ["backend-architecture", "facade-boundary"],
  "transition": "merge",
  "exception_policy": "owner-reason-expiry"
}
```

### Agent 适配

Codex 与 Claude Code 使用同一个 `SKILL.md` 和脚本，只在安装入口与 UI metadata 上适配。未来 Agent 应继续链接同一个源目录，禁止复制后各自漂移。

## 4. 贡献流程

1. 用真实事故、审计发现或明确需求描述治理缺口。
2. 判断属于通用内核、项目 Profile 还是技术栈控制器。
3. 先写失败测试或最小复现，再实现。
4. 更新分析/契约，运行单元测试、Skill validator 和两个 Agent 的前向调用测试。
5. 报告新增门禁的运行成本、误报风险和迁移方案。

## 5. 不变量

- 不用 Agent 名称决定规则语义。
- 不执行来自 Profile 的 shell 字符串，只接受 argv 数组。
- 不把 quick 验证描述成完成门禁。
- 不用更新 baseline/allowlist 自动修复失败。
- 不因找不到 Profile 就静默通过。
- 不把“workflow 存在”当作“branch protection 已要求”。
- 不把 Skill 提示词执行情况当作验收结果；只认 Code Harness 和 required CI。
