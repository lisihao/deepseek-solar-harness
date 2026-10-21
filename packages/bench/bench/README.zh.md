# @deepseek-ai/dsh-bench

[English](README.md) | 中文

benchmark 能力的 Service Definition：由套件和评分器组成的 `ctx.benchmarks` 注册表。套件插件向它注册任务，benchmark 运行器（`dsh-bench-runner`）读取它来运行实验。本包还提供声明式套件格式和三个内置评分器，因此大多数 benchmark 只需以数据形式添加，无需新代码（[cookbook](../../../docs/cookbook/adding-a-benchmark.md)）。

## 服务 API（`ctx.benchmarks`）

| 方法 | 约定 |
|---|---|
| `registerSuite(suite)` | 以 `id` 注册一个 `BenchSuite`，id 重复时拒绝。注册是调用方 fiber 上的 effect，返回的 disposer 用于注销。 |
| `registerGrader(grader)` | 以 `kind` 注册一个 `BenchGrader`，kind 重复时拒绝，内置 kind 也算在内。生命周期同 `registerSuite`。 |
| `suite(id)` / `suites()` | 查找单个套件，或按注册顺序列出全部套件。 |
| `grader(kind)` | 查找评分器；内置 kind 始终存在。 |

`BenchSuite` 包含 `id`、`version`（任一任务的 prompt、fixture 或评分器变化时必须修改）、`description`，以及返回任务列表的 `load(signal?)`。`BenchTask` 包含 `id`、`prompt`（本次运行唯一的一条用户消息）、可选的绝对路径 `fixture` 目录（复制进运行工作区）、`grader` 规格（`{ kind, ...参数 }`）和 `tags`。`BenchGrader` 包含 `kind`、`version`（同一规格的评分结果会变化时递增）、`validate(spec)`（参数不合法时在任何运行开始前抛错），以及 `grade(spec, { workspace, events, signal })`，后者返回 `{ pass, score, details }`。

## 声明式套件

`loadDeclarativeSuite(dir)` 读取一个绝对路径目录：

- `suite.yml`：`id`（小写字母、数字、连字符）、`version`、`description`。
- `tasks.jsonl`：每行一个 JSON 对象，含 `id`、`prompt`、可选的 `fixture`（相对套件目录的子目录，不得越出套件目录）、`grader`，以及可选的 `tags`。id 必须唯一。

创建套件时校验 header。每次 `load()` 都会重新读取并校验任务，因此修改后的任务文件对下一次实验生效。错误信息会给出文件和行号。

## 内置评分器

| Kind | 参数 | 通过条件 |
|---|---|---|
| `command-exit` | `command`（argv，不经 shell）、`timeoutMs`、可选的 `expectExit`（默认 0） | 命令在工作区内运行，并在超时前以 `expectExit` 退出。`details` 附带其输出的最后 2000 个字符。 |
| `file-contains` | `path`（相对工作区，不得越出工作区）、`text` | 该文件包含 `text`。文件不存在算本次运行失败，不算评分器错误。 |
| `session-event` | `tool`，`min` 和/或 `max` | 会话日志中名为 `tool` 的 `tool/call` 事件数在 `min` 与 `max` 之间。 |

## 组合

```yaml
- id: benchmarks
  name: '@deepseek-ai/dsh-bench'
```

## 模型体验

无，因为注册表只存放套件和评分器定义，并离线为已结束的运行评分；它不注册任何 prompt、工具、schema 或会话事件。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知局限与延后工作

- **仅支持单轮任务** — 一个任务只有一条 prompt；多轮脚本和预热会话（测量记忆类插件所需）要等 ACP driver。
- **只有三种评分器** — `json-match` 和 `ast-call-match`（BFCL 等工具调用准确率套件所需）随第一个用到它们的套件一起加入。
