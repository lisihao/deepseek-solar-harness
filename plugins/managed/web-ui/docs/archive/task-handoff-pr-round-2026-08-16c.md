# 任务交接：远程 PR 集中处理轮（2026-08-16c）

> 本文件记录 2026-08-16c PR 集中处理轮的结果。执行原则：只审修复 / 增强型 PR
> 与内容贡献（社区索引登记）；全新功能 PR 按 CONTRIBUTING.md 直接关闭；
> 能合入的先本地 worktree 验证再合入，不能合入的回复评论；同时处理远程仓库的
> bug 报告 issue。执行分支：triage/pr-round-2026-08-16c（基于 origin/main 9ccc56b4）。

## PR 处理结果

| PR | 类型 | 结论 | 动作 |
| --- | --- | --- | --- |
| #268 feat(dsh-pet) 鲸鱼娘皮肤切换 | 新特性 | 已关闭 | 评论说明（settings 新字段 + skin atlas 注册属于宠物功能的全新能力，超出修复/增强范围，需先提 issue 讨论）后关闭 |
| #269 皮肤扩展兼容机制（任意 scope 发现 + manifest） | 新特性 | 已关闭（追记） | 合并后到达（0388ac3），按同一原则评论说明后关闭：开放扩展机制属全新能力，需先提 issue 讨论；证据检查亦为红 |
| #253 / #237 / #209 / #205 | — | 无新变动 | 作者未按上轮评论更新，维持请求变更 |
| #6/#63/#91/#101/#104/#105/#168 | — | 无新变动 | 未处理（上轮已回复） |

## issue 处理结果

| Issue | 结论 | 动作 |
| --- | --- | --- |
| #267 换肤后 web 端无法再次打开（duplicate loader entry id: ui-skin-blue-fantasy） | 已修复 | 本分支修复：遗留 skin insert 行清理改为按行识别（不依赖旧注释行 / 缩进 / scope 格式）并折叠空 insert 块；useSkin 写盘前核对目标 id 的 insert 行数，已有同名行时跳过本层 insert、只写互斥 disabled 行。commit e1fceec7，skin-center 85/85。issue 关闭（completed）并留言附恢复步骤 |
| #266 梁神模式优化建议（按模型双分支） | 设计分享 | 留言记录为预设后续升级参考，保持打开跟踪 |
| #234 / #189 / #164 | 跟踪中 | 无新变动（#234 等 biaoqingbao 抽屉侧根层渲染；#189 等报告者补充版本信息；#164 上游范围） |

## 本机验证记录

- skin-center 包构建 + 单测（85/85，含 2 个新回归用例）、test:scripts（88/88）、
  skin-center:check（10 skins in sync）全绿；lib/index.js bundle 与源码同 PR
  提交（diff 无路径噪声）。
- 环境：Node v25.8.1 + pnpm 11.9.0（CI 为 Node 22）。

## 遗留（下轮关注）

- #253 / #237 / #209 / #205 作者按评论补齐模板 / rebase 后即可合入。
- #237 与 #227 同追加 community.json 尾行，合入需顺序 merge 并重新生成 community.ts。
- #234 等待 biaoqingbao 抽屉侧根层渲染（z-901）落地后关闭；#189 等待报告者补充
  版本与层级信息。
- #267 若报告者升级 0.1.16 并按恢复步骤后仍复现，按其贴回的补丁与 profile
  manifest 继续跟进（可能涉及 19043d79 install-layout 兜底之外的边角）。
- 可选：scripts/dsh-skin CLI 的 stripLegacySkinRows 与 use 路径可同步本轮的
  行级清理与同名 insert 自愈。
