# @deepseek-ai/dsh-rlm-runtime

[English](README.md) | 中文

持久、可编程递归语言模型 Runtime 的 Provider-neutral Service Definition。本包不持有 Scheduler 策略，也不直接调用原生模型。

## Service API

`ctx.rlmRuntime` 暴露 Root 生命周期、持久 TypeScript Cell、异步 Child 准入、Child 检查、家庭范围消息、持久 Goal、事件游标、中断、重置、Receipt 绑定的压缩调度、Receipt 检查、显式放弃 indeterminate command 和对账。Consumer 提供 `RlmRuntimeHostBindings`；Provider 不得 import 物理算子或编排实现。

Prime Agents View 的控制面按版本化的 `attach → input → detach` 提供。`attach` 使用 caller id 与 command id 建立一个排他的 lease，并返回当前 Session snapshot 和 event cursor；第二个仍存活的控制者会以 `RLM_CONTROL_BUSY` 失败。`input` 必须持有 lease，并进入已有的 message/continuation 路径，不会创建另一套 Scheduler；重复 command id 返回同一 Receipt，冲突 payload 会失败。`detach` 幂等。Lease 通过属主进程隔离，因此 Provider 重启后可以回收死进程遗留的 lease，而持久 RLM Session 仍可用。

`RLM_TYPESCRIPT_REPL_TOOL_SCHEMA` 是 `typescript_repl` bridge 的 canonical `ToolSchema`；Consumer 应复用它，不要维护第二份描述或 JSON Schema。

变更调用使用调用方生成的 command identity。`rlm(...)` 准入返回 `RlmChildHandleV1`；Child answer 随后通过消息或 Artifact reference 到达。可编程 `skills.list()` 返回 Host 签发的 `RlmManagedSkillDescriptorV1.alias`，`skills.call(name, args)` 只接收这些 alias。Alias 使用公共 kebab-case Skill 语法，最长 128 字符。Host 把每个 alias 映射到受管条目及其 TypeScript import/callable；Kernel 不能提交 title 或 `reference.import`。两个操作的成功和失败都返回 `RlmManagedSkillResultV1`。恢复出的不确定命令保持 `indeterminate`，直到可信调用方记录 `abandon`；重放不会猜测原生执行结果。

模型侧压缩接口是 `compact.status()` 与 `compact.run({ instructions? })`。精确 Host wire method 分别为携带 `{}` 的 `compact.status`，以及携带 `{ instructions? }` 的 `compact.run`。`compact.run` 记录 Host 返回的 `scheduled`、可选 `reason` 和可选 `note`，不声称历史已经完成压缩；真实 turn boundary 调度与原生历史操作仍由 Host 持有。

## 扩展点

Provider 可以使用本地进程、远端 Worker 或其他持久 Kernel，只要不改变版本化可观察契约。Consumer 可以通过同一 Host interface 绑定 DSH Resident 物理算子或测试 Fixture。

## Model Experience

Indirectly, through the model-facing TypeScript REPL Consumer that maps this service to a genuine provider tool.

#### KV Cache effect

Service Definition 没有直接 Token 或 KV Cache 影响；Tool Schema 和结果呈现由 Consumer 持有。

## Known Limitations and Deferred Work

- **需要 Provider** — 单独加载此抽象包不会创建 Kernel 或执行 Child。
- **兼容子集** — DeepSeek、Claude Code、Codex 的原生 Host tool 路径与 Continuous Harness 通过固定端到端矩阵前，不声明 Prime compatible。
