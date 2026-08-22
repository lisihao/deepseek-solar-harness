# Agent Note: 受控 Desktop 插件组合

Status: implemented

[English](2026-08-22-controlled-desktop-plugin-composition.md) | 中文

## 问题

DSH Desktop 曾同时组合产品自有能力与 profile 安装的插件版本。旧 Better Sidebar 可能与聚合 Web UI 中的副本同时挂载，而 Desktop 会把物理算子和编排入口放在 sidebar footer。Memory Evolve 与 Luna Vision Bridge 还会重复提供已接受 Mnemon 插件和原生 DeepSeek 视觉模型具备的能力。Aegis 自带的 agent bootstrap 也可能在用户的 Code-as-Harness 项目旁形成第二个完成权威。

## 决策

Desktop 依赖图封装每个已接受的受控插件，并把归档映射到 `plugins/managed` 下的已跟踪源码，从而扩展 [Desktop 源码闭包决策](../process/2026-08-20-desktop-source-closure.md)。Product-first 依赖解析会向直接消费方与聚合消费方提供已接受的 Better Sidebar；若聚合 owner 已激活，Better Sidebar 会拒绝第二次挂载。Desktop 会在当前 Session header 中注册物理算子和编排，而不是使用 `sidebar.footer.action`。

Mnemon 是唯一产品记忆 bundle。Profile 组合会从产品 bundle 列表移除 Memory Evolve，并禁用陈旧的显式 Memory Evolve row，但不会删除用户文件。原生 DeepSeek provider 将 `deepseek-v4-flash-vision-exp` 声明为支持文本和图像输入，因此产品依赖图不包含 Luna Vision Bridge 与 Modlens。

Aegis 只贡献 skills 目录，不提供 bootstrap 或提示词注入。用户创建的 `agent-development-governance` 仍是唯一的 Code-as-Harness 完成、attestation 与准入权威。插件检查、模型 fallback、GenUI、代码图谱支持，以及有界的 stat、time、regex 与 Markdown 工具都继续作为该权威管理下的普通产品能力。

## 打包与验证

[`plugins/registry.yaml`](../../../../plugins/registry.yaml) 记录已接受 revision、许可证和原生检查。[`products/desktop/dsh-plugin-desktop/vendor/manifest.json`](../../../../products/desktop/dsh-plugin-desktop/vendor/manifest.json) 把封装归档映射到已跟踪包与字节。完整受控插件检查会执行各组件的原生构建或测试命令；Desktop profile 与打包组合检查要求每项产品能力只有一个启用 row、拒绝已退役 row、加载原生视觉模型，并解析打包后的客户端模块。安装验收还会验证 Session header 拥有两个运维 action，且 sidebar 保持可交互。

## 考虑过的替代方案

**使用 profile 安装的插件版本。** 拒绝，因为 fresh clone 和构建后的应用可能运行不同包，聚合依赖也可能重新引入旧 sidebar 实现。

**让 Memory Evolve 与 Mnemon 共存。** 拒绝，因为两套记忆设置和提示词策略会产生冲突归属。禁用陈旧 row 可以保留用户数据，同时只留下一个产品记忆实现。

**保留 Luna Vision Bridge 作为 fallback。** 拒绝，因为原生 provider 拥有已接受的多模态模型，第二条图像转文本请求路径会改变 provider 选择与计费。

**加载完整 Aegis DSH bootstrap。** 拒绝，因为其提示词注入与 agent runtime 会和显式 Code-as-Harness 权威重叠。Skills 保留有用的方法库，同时不会创建第二个治理者。

**把运维 action 留在 sidebar footer。** 拒绝，因为这些 action 是 Session 范围的检查界面，却会占用 sidebar 插件和 Session 列表所需的导航列空间。

## 后果

公开仓库包含默认 Desktop 组合的可编辑源码与封装输入。插件更新必须包含受管源码 revision、兼容包范围、重建归档、manifest 证据、原生检查和 Desktop 组合验收。用户 profile 数据保持在 Git 之外，不会因产品退役而被删除。产品放弃 Memory Evolve 专有演进工作流、Luna 订阅桥接、Modlens 与 Aegis bootstrap 行为，以换取单一记忆 owner、单一原生视觉路径、单一治理权威和单一 sidebar owner。
