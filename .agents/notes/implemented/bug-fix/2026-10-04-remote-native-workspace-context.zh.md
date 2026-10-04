# Agent Note: 远程原生工作区上下文与私有准入输入

Status: implemented

[English](2026-10-04-remote-native-workspace-context.md) | 中文

## 问题

远程执行器在宿主本地路径物化仓库，而密封的 TaskGraph 上下文可能包含发送方工作区与历史绝对路径。把这些路径当作接收端目录会让原生文件操作访问错误位置。规范请求 hash 能识别已准入内容，却不能重建实际交给原生 Driver 的已解析输入。HTTP 5xx 响应也不能确定远程命令是否已经准入。

## 决策

[TaskGraph 提示词拥有者](../../../../packages/orchestration/orchestration-local/README.md#model-experience)将源路径标为 `Sender workspace`，并指示原生执行器以当前工作目录使用列出的相对范围。[Remote Sync Host](../../../../packages/client/connection/README.md#remote-sync-and-stable-session-handoff)向执行系统提示词追加确定性的 JSON，包含接收端 cwd、仓库身份和 commit。它保留原始任务、历史路径、信封和 digest；已接受上下文回执只识别原始输入。这将密封的源上下文与派生的宿主输入分开，不扩展权限。

[Resident daemon](../../../../packages/physical-operator/resident-operator-local/README.md#protocol-storage-and-recovery)仍是唯一准入写入者。它在调用 Driver 前，将完整的规范已解析输入原子保存在私有 accepted 事件中，并在公开进展投影中移除该快照。相同 command/hash 的重放保留首份快照；hash 不同则冲突。已有事件仍可读取，不增加 schema、表或协议版本。

远程 HTTP 5xx 诊断保留有界响应体，或使用响应体不可用说明，同时保留传输失败和命令状态不确定的语义。准入或执行阶段未知时需要核对状态，不自动重放。

## 考虑过的替代方案

**改写任意发送方文本或历史路径。** 文本替换可能改变任务含义，并使密封输入的 digest 失效。明确的接收端补充内容保留原始材料，单独指明执行目录。

**只保留请求 hash，或增加另一输入写入者。** hash 无法恢复已解析的 Driver 输入。将输入记录在现有原子准入事件中，既保留唯一 Resident 写入者，也避免准入记录不完整；公开投影防止私有输入成为进展输出。

**将每个 5xx 响应体视为拒绝，或自动重试。** 状态码和正文都不能确定外部操作的效果。宽泛的捕获重试或基于启发式的任务修复可能重复执行已成功准入的命令。传输诊断保留证据，不改变分类或任务验收。

## 影响

执行提示词可以同时包含历史源路径与权威的接收端 cwd。远程允许列表中的源仓库必须实际包含锁定 commit；此决策不会使不可用的 commit 变得可物化。相对范围和唯一 TaskGraph Scheduler 保持不变。

属主本地 Resident 数据库包含敏感的已解析输入，必须保持私有。不含快照的旧 accepted 事件不保证能重建输入。公开投影仍排除提示词、私有推理与原始终端 transcript（文本记录）。

聚焦的远程、Resident 与发送方提示词测试覆盖接收端补充内容、原始上下文回执身份、原子输入保留、重放与冲突行为、公开投影和有界传输诊断。原生进程结束本身不能证明读取了 README 或任务验收通过；实际原生 README 成功与已安装运行时交付不在这些证据范围内。
