# 分析文档（Phase 1）

spec-driven 重构 Phase 1 的只读分析产物，基于 perf/webui-plugin-suite @ a7a38401。

| 文档 | 内容 |
| --- | --- |
| [project-overview.md](project-overview.md) | 仓库架构、技术栈、入口点、构建/验证命令、测试基线、治理基线、S.U.P.E.R 10 项判定、每包 TOP 建议 |
| [module-inventory.md](module-inventory.md) | 22 个包逐包模块条目（职责/API/依赖/复杂度/性能观察/S.U.P.E.R/转换注意）与跨包重复清单（由 part1-part3 合并） |
| [risk-assessment.md](risk-assessment.md) | S.U.P.E.R 健康总评、违规与性能热点 TOP10、复制粘贴债务、类型缺口、兼容性/测试/治理风险矩阵 |

## 关键结论（供 Phase 2/3 引用）

- 全局健康：S.U.P.E.R 五原则整体 partial；最大短板是 S（复制粘贴）与 P（缺 schema 契约）。
- 复制粘贴热点：settings 卡片三件套（settings-form.ts + PluginSettingsCard.tsx + settings-card.module.css）在 pet/task-board/remote-web-ui 逐字节相同；git-service 与 poll guard 在 git-graph/aionui-panel 双实现；SSE 订阅簿/心跳与 loopback 栅栏在 aionui-panel/remote-web-ui 重复；10 皮肤 apply/dispose 样板重复。
- 性能热点：pet 0.8s 高频轮询、trading 皮肤 3 个 setInterval 全量刷新、git 轮询每 tick 起 subprocess、aionui-panel 大表格 index key、localStorage 全量遍历。
- 类型缺口：全仓 as 断言 847 次、any 125 次；top 文件 skin-switch.ts(22)、tool-describe-image index.ts(21)。
- 兼容性：SDK 统一 rc.6 pinned、engines ^22.19 || >=24、Windows .cmd 仅 remote-web-ui 处理。
