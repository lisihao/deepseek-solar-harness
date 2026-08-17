# Agent Note: Solar monorepo 与隔离的 Desktop Yarn 工作区

Status: implemented

[English](2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md) | 中文

## 问题

DSH Desktop 原先把 DeepSeek Harness 官方 checkout 作为嵌套 Git submodule。该拓扑能够保留源码来源，但也把 Solar 产品拆分在多个仓库中，使 Desktop、核心和受管插件的协同开发更困难。本次迁移必须统一源码归属，同时不能把 Desktop 的 Yarn 依赖图耦合到核心 pnpm workspace，也不能悄悄改变已打包的运行时输入。

## 决策

[`products/desktop/`](../../../../) 现在是 DeepSeek-Solar-Harness monorepo 中的 Desktop 产品目录。Solar Harness 源码位于 [monorepo 根目录](../../../../../..)；禁止嵌套 `deepseek-harness/` checkout，也禁止 Desktop 自己的 `.gitmodules` 文件。[ADR-002](../../../../../../docs/architecture/adr-002-monorepo.zh.md) 负责定义仓库拓扑。

Desktop 继续作为使用 `node_modules` linker 的 Yarn 4 workspace，唯一 workspace 成员是 [`dsh-plugin-desktop/`](../../../../dsh-plugin-desktop/)。Solar 根目录保留固定的 pnpm 版本和 workspace。本地 `solar:*` 脚本会先进入 monorepo 根目录，再通过 Corepack 显式跨越该边界。

P1-P2 的源码共置本身不会改变产品依赖解析。普通 Desktop 构建继续使用 [`upstream.json`](../../../../upstream.json) 记录的已发布 DSH `0.1.0-rc.6` family；sealed 产品扩展继续使用 `dsh-plugin-desktop/vendor/dsh-packages/` 下经过 hash 校验的 tarball。后续资格审查过的集成阶段必须显式改变 package 输入，并证明运行时兼容性，Desktop 才能消费同仓源码。

`yarn check:layout` 会拒绝嵌套 Harness checkout、变化的包管理器边界、扩大的 Desktop workspace、无效的 Solar 根目录、变化的运行时 family 或未封装的扩展引用。该检查还会通过双语 hash 记录绑定本决策文件。

## 验证

迁移从 `products/desktop/` 使用 `corepack yarn install --immutable`、`corepack yarn check:layout` 和 headless `corepack yarn check` 套件验证 Desktop 边界。核心与治理验证在 monorepo 根目录独立运行。迁移专用验证不会启动 Electron，也不会修改 `/Applications/DSH Desktop.app`。

## 曾考虑的替代方案

**保留嵌套 submodule。** 否决，因为它会保留 Solar monorepo 本来要消除的仓库拆分，并重复核心源码位置。

**立即把 Solar 根 package 加入 Desktop Yarn workspace。** 否决，因为源码共置并不能证明 pnpm 与 Yarn 依赖图可以安全合并，而且会在结构迁移期间改变打包运行时输入。

**把核心复制进 Desktop 目录。** 否决，因为这会为同一源码建立两个可编辑权威，并模糊发布与治理归属。

**在 P1 同时删除已发布和 sealed package 输入。** 否决，因为这会把拓扑迁移与运行时集成混在一起，使失败难以准确归因。

## 后果

核心、Desktop 与受管插件源码可以在同一个 Solar 仓库内演进，同时保留明确产品边界。贡献者在 monorepo 根目录使用 pnpm，在 `products/desktop/` 使用 Yarn。P1-P2 期间现有打包依赖 family 不变，因此后续源码集成阶段仍必须审查并记录任何依赖边界变更。
