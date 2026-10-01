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

网关从不运行 `refresh`、`import`、`consent`：它们会访问网络或写入已存储的版本，属于持有授权文件的周期任务。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `python` | 必填 | Python 3.11+ 解释器，绝对路径，或在清理过的 `PATH` 中查找的裸名称 |
| `sourceRoot` | 必填 | `python/scheduling-evidence/src` |
| `stateRoot` | 必填 | 所有者私有目录；每个采集器把 SQLite 版本保存在其下的 `radar/` 或 `ai-frontier/` |
| `timeoutMs` | 15000 | 一次调用的期限 |
| `graceMs` | 2000 | SIGTERM 与 SIGKILL 之间的宽限 |
| `maxOutputBytes` | 1048576 | 每次调用保留的 stdout 或 stderr 上限；stdout 更大则调用失败 |

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

- 目前没有任何代码使用这个网关。读取这些文档的周期任务和分配器接线是[调度迁移](../../../.agents/notes/proposed/architecture/2026-09-30-workbench-scheduling-migration.md)的后续阶段。
- 采集器只通过 `refresh` 或 `import` 接收 Radar 或 AI Frontier 载荷，而网关不运行这两条命令，所以在周期任务出现之前，空状态目录会一直报告 `ok: false`。
- 解释器版本每个网关只检查一次；不重新加载插件就替换磁盘上的解释器，不会被察觉。
