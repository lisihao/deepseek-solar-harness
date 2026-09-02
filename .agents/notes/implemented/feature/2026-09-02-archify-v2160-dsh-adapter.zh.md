# Agent Note: Archify v2.16 DSH adapter

Status: implemented

English | [English](2026-09-02-archify-v2160-dsh-adapter.md)

## Problem

面向架构工作的 agent 需要 typed diagram 能力，但 Archify 的渲染器、schema 或文件所有权不能进入 DSH Core、TaskGraph 或 Scheduler。

## Decision

托管插件 `@deepseek-ai/dsh-archify` 固定 vendored Archify `v2.16.0`，来源提交为 `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`，并通过一个模型可调用的 `archify` 工具暴露上游全部五种图：architecture、workflow、sequence、dataflow 和 lifecycle。

适配器把 typed JSON 输入写入私有临时目录，通过注入的 `ctx.subprocess` 接缝以显式 argv 启动固定 CLI，并使用有界输出收集。它不使用 shell，也不导入宿主 `child_process`；取消、超时终止、进程树清理和执行世界策略由 DSH subprocess 服务负责。

插件把适配器 receipt、生成的 HTML/JSON 以及上游 compare receipt 写入工作区内容寻址存储，只发布命名 delivery 投影，并不把原始 prompt 或完整 HTML 放入会话结果。插件 manifest 明确声明上游运行时依赖，因此独立安装 tarball 不依赖宿主偶然 hoist。

插件 skill 指导架构、设计、需求和审核 agent 生成 typed IR，先校验，再在检查诊断与 receipt 引用后交付。交互式 `preview` 与 `--open` 不进入模型工具面；保真矩阵记录这一明确边界。

## Alternatives considered

**把 Archify 渲染器复制进 DSH 包。** 这会产生第二套 schema 与渲染权威，因此精确锁定的运行时继续通过插件适配器 vendored。

**由适配器直接启动 Node。** 这会绕过 DSH 的 subprocess 执行世界和 HMR/进程树生命周期，因此所有 CLI 执行都通过注入的 `ctx.subprocess`。

**只暴露简化的 architecture 子集。** 这不满足上游契约，因此适配器保留五种图，以及适合有界工具结果的 validate、deliver、compare、migrate、inspect、guide、doctor、visual-check、examples 和 brands 命令。

**把交互式 preview 暴露为模型 action。** preview 与浏览器打开需要交互式 UI 边界，不适合作为有界模型结果，因此保留为明确省略；未来 UI/CLI consumer 仍可调用 vendored runtime。

## Consequences

Archify 作为独立锁定版本的托管插件演进，DSH host 继续拥有进程执行、会话日志和编排状态。包内携带上游运行时及其显式依赖，tarball 体积会增加，但安装行为可复现。未来升级 Archify 必须生成新的 source lock 并刷新保真矩阵，不能无提示改变 v2.16 行为。

## Verification

适配器测试通过真实本地 `ctx.subprocess` provider 执行五种图各一个上游示例的精确 validator，验证 delivery 与 compare 的 CAS receipt，拒绝不安全路径，断言非零退出返回结构化失败，并断言实现没有宿主 `node:child_process` 导入。发布集成前必须执行 `npm run typecheck`、`npm test`、`npm run build`、vendored `doctor` 和 npm pack dry-run。
