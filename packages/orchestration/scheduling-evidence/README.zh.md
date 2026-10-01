# @deepseek-ai/dsh-scheduling-evidence

[English](README.md) | 中文

[`python/scheduling-evidence`](../../../python/scheduling-evidence/README.md) 中 Radar 与 AI Frontier 证据采集器的网关。它注册 `ctx.schedulingEvidence`，通过 `ctx.subprocess` 把采集器的只读命令作为有界子进程运行，并返回每条命令输出的 JSON 文档。

## 服务

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-scheduling-evidence'

export async function readEvidence(ctx: Context, snapshotId: string, signal: AbortSignal) {
  const radar = await ctx.schedulingEvidence.status('radar')
  const frontier = await ctx.schedulingEvidence.show('ai-frontier', { snapshotId, signal })
  return { radar, frontier }
}
```

`status(collector, signal?)` 与 `show(collector, { snapshotId?, signal? })` 返回 `{ ok, exitCode, document }`。`ok` 是文档自己的 `ok` 事实。采集器没有有效版本或命令失败时，以退出状态 1 或 2 返回 `ok: false`；这是数据，不是错误。`collector` 取 `'radar'` 或 `'ai-frontier'`。

`status` 与 `show` 从不运行 `refresh`、`import`、`consent`：它们会访问网络或写入已存储的版本。只有下文的 Radar 周期会运行 `consent` 与 `refresh`。

`evidenceFor(offers, taskType)` 返回分配器比较用的 `ModelAllocationEvidence`，或 `undefined`。它读取内存中的 Radar 版本，不启动任何进程，所以分配器可以在每次请求时调用。只有同时满足以下条件才产生记录：`taskType` 等于声明的 `taskType`，版本比它自己的 `cache.stale_after_seconds` 新，且某个 offer 的 provider、模型（经 `modelAliases` 映射后）和推理强度与 Radar 的一行相符。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `python` | 必填 | Python 3.11+ 解释器，绝对路径，或在清理过的 `PATH` 中查找的裸名称 |
| `sourceRoot` | 必填 | `python/scheduling-evidence/src` |
| `stateRoot` | 必填 | 所有者私有目录；每个采集器把 SQLite 版本保存在其下的 `radar/` 或 `ai-frontier/` |
| `timeoutMs` | 15000 | 一次调用的期限 |
| `graceMs` | 2000 | SIGTERM 与 SIGKILL 之间的宽限 |
| `maxOutputBytes` | 1048576 | 每次调用保留的 stdout 或 stderr 上限；stdout 更大则调用失败 |
| `radar` | 缺省 | 下面的 Radar 周期与证据设置；缺省时网关不启动定时器，`evidenceFor` 返回 `undefined` |

`radar` 设置：

| 键 | 默认值 | 含义 |
|---|---|---|
| `authorizationFile` | 缺省 | 所有者的授权凭据。没有它就不发任何网络请求 |
| `personalUseConsent` | false | 所有者的个人使用同意声明。为 true 且凭据文件不存在时，周期用 `consent --personal-use` 记录一次。任何随产品发布的默认配置都不设置它 |
| `refreshIntervalMs` | 14400000 | 周期间隔，30 分钟到 24 小时 |
| `refreshTimeoutMs` | 90000 | 一次 `refresh` 的期限 |
| `staleAfterSeconds` | 604800 | 传给 `refresh`；已存储版本超过它自己的期限后不再使用 |
| `benchmark` | `Codex Radar community tasks` | 记录所声明的基准名称 |
| `harness` | `codex-radar-community` | 所有者声明 Radar 所有行共用的测试环境 |
| `taskType` | `coding` | Radar 数据集唯一适用的任务类型 |
| `modelAliases` | `{}` | 把 Radar 的模型名映射为 offer 使用的名称 |

`harness` 是声明，不是 Radar 报告的事实。Radar 通过率只在同一数据集内可比，所以只有两行声明的 harness 相同且其余九个队列条件一致时，分配器才能区分两个模型。

## Radar 周期

设置了 `radar` 后，网关在启动时运行一次周期，之后每 `refreshIntervalMs` 运行一次。每个周期依次执行 `consent`（仅当凭据文件不存在且 `personalUseConsent` 为 true）、`refresh`（仅当凭据文件存在或刚刚记录）、`show`，并在输出含 `snapshot_id` 时把该版本保留在内存中。没有 `authorizationFile` 时，周期只读取已存储的内容。周期失败会记为警告，并继续使用上一个版本。重叠的周期会合并为正在运行的那个。销毁服务会清除定时器。

## 行为

- 第一次调用会解析解释器并只询问一次它的版本；低于 3.11 的 Python 以 `INTERPRETER_UNSUPPORTED` 失败，而不是采集器里的导入错误。检查失败的话，下一次调用会重试。
- 每次调用是一条 `python -m <collector>.cli --state-root <dir> <command>`：显式 `argv`、`PYTHONPATH=sourceRoot`、不写字节码和用户站点目录、关闭 `stdin`。子进程继承清理过的父进程环境，所以形如凭据的变量不会传给它。
- 调用在超过期限、调用方的 `AbortSignal` 触发、以及服务销毁时结束整个进程树；销毁会等待每棵树退出，之后的调用以 `GATEWAY_DISPOSED` 失败。
- 失败是带稳定 `code` 的 `SchedulingEvidenceError`：`INTERPRETER_UNAVAILABLE`、`INTERPRETER_UNSUPPORTED`、`COLLECTOR_SPAWN_FAILED`、`COLLECTOR_TIMEOUT`、`COLLECTOR_ABORTED`、`COLLECTOR_OUTPUT_INVALID`（被截断、不是 JSON 或不是对象）、`COLLECTOR_FAILED`（退出状态异常或被信号杀死，附 stderr 末尾），以及 `GATEWAY_DISPOSED`。

## 模型体验

无。网关不注册 prompt、工具或会话事件，它返回的文档也不会进入任何模型请求。

#### KV 缓存影响

无；网关不会向请求前缀添加任何内容。

## 已知限制与后续工作

- 周期只覆盖 Radar。AI Frontier 可通过 `status` 与 `show` 读取，但没有周期，也没有代码把它交给分配器。
- Radar 的行按 provider、模型名和推理强度匹配。Radar 拼写不同的模型需要 `modelAliases` 条目；Radar 没有列出的模型没有记录，分配器对它弃权。
- 发布的组合不挂载这个网关，所以在所有者添加 `radar` 设置和授权文件之前，任何安装都不会采集或使用 Radar 证据。
- 解释器版本每个网关只检查一次；不重新加载插件就替换磁盘上的解释器，不会被察觉。
