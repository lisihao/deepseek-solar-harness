# ADR-002：单一产品 monorepo

状态：已接受

[English](adr-002-monorepo.md) | 中文

## 背景

DSH 核心、Desktop 外壳和修改过的插件原本分散在多个仓库。绝对 `file:` 链接、打包归档和嵌套上游 submodule 可以支撑现有安装，但不能形成一份可统一评审的源码闭包。

## 决策

Solar 仓库成为唯一产品源码。现有核心保留在仓库根目录，以维持 pnpm workspace。Desktop 源码进入 `products/desktop`，不再携带嵌套 DeepSeek Harness submodule。Solar 接管的插件源码进入 `plugins/managed`，产品清单进入 `distribution`。

首次迁移保留每个导入仓库的历史和锁文件。核心继续使用 pnpm，Desktop 继续使用 Yarn，直到另一个决策证明统一包管理器能够降低风险。源码导入不得包含 `node_modules`、构建产物、凭据、用户 profile、会话、记忆或已安装应用。

## 后果

全新 clone 可以检查并修改所有 Solar 所有的输入，不再依赖相邻源码仓库。迁移期间仍可使用每个组件原生的测试。构建整合、profile 组装和最终源码闭包属于后续阶段，不能因为源码已经共置就宣称完成。
