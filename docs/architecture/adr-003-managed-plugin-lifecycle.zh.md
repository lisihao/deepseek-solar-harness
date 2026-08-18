# ADR-003：受管插件生命周期

状态：已接受

[English](adr-003-managed-plugin-lifecycle.md) | 中文

## 背景

DSH 会安装大量第三方插件，但只有为 Solar 修改的插件才需要进入产品所有权。把每个已安装依赖都当作源码会制造不必要的维护负担；把修改后的插件继续放在产品仓库之外，又会让修复无法复现。

## 决策

插件只有 `external` 与 `managed` 两种状态。external 插件以锁定版本和 revision 使用，不包含 Solar 源码修改。managed 插件包含 Solar 修复或功能，带历史导入 `plugins/managed`，并在 `plugins/registry.yaml` 登记包身份、来源与上游 URL、已接受 revision、许可证状态和本地测试命令。

晋升为 managed 必须完成源码与许可证检查、移除绝对运行时链接、组件测试、组合后的 DSH 或 Desktop 验收路径以及上游监测。此后的 Solar 修改只留在本 monorepo，禁止回馈上游。

## 后果

仓库只接管必须维护的代码。来源缺失、许可证未知、源工作区不干净或 revision 未验证都会使导入 fail closed。运行时 shim 只能作为临时方案，并必须有明确退出条件。
