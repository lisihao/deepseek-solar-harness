# @deepseek-ai/dsh-bench-runner

[English](README.md) | 中文

benchmark 能力的 Service Provider：`ctx.benchRuntime` 运行一个实验，即 `ctx.benchmarks` 中某个已注册套件的每个（variant、任务、重复次）组合，每次运行都是一个相互隔离的 `dsh` 子进程。它为每次运行评分，把会话日志折叠为指标，并为每次运行向实验账本追加一条记录。把基线 variant 与加装插件的 variant 对比，即可测出每个插件带来的变化。

## 实验

`readExperiment(file)` 解析 YAML 格式的实验：

```yaml
id: mnemon-ablation          # ledger directory name
suite: dsh-native
profile: headless            # dsh --profile <profile>
repetitions: 3               # runs per (task, variant)
tasks: [fix-sum-bug]         # optional subset, in suite order
variants:                    # the first is the baseline
  - id: baseline
  - id: mnemon
    patches: [./mnemon.patch.yml]            # --patch overlays, relative to this file
    env: { MNEMON_DATA_DIR: '{cell}/mnemon' } # {cell} = the run's private state directory
```

`run(experiment, { signal, onProgress })` 在任何运行开始前，会拒绝未注册的套件、未知任务、未注册的评分器或不合法的评分器规格。之后它运行账本中尚无记录的每个 cell，排序依次按重复次、任务、variant，这样实验中途停止时各 variant 的完成量仍然均衡。返回值是账本中的全部记录。中止会杀掉正在运行的子进程；未完成的 cell 不记录，下次调用时继续运行。

## 运行隔离

每次运行的目录 `<ledgerRoot>/<experiment>/cells/<variant>/<task>/<rep>/` 包含：

- `workspace/`：agent 的工作目录，从任务 fixture 复制而来。
- `home/`：私有的 `$DSH_HOME`，内含 `<templateHome>/profiles/<profile>` 的副本和 `templateFiles`。会话、附件等由 home 派生的状态都留在其中。
- `state/`：variant `env` 中 `{cell}` 指向的目录，用于存放 `$DSH_HOME` 之外的插件状态。

文件系统支持时，复制使用克隆。崩溃的运行留下的目录会在下次尝试时被替换。子进程继承运行器的环境，外加 `DSH_HOME` 和展开后的 variant `env`，执行 `<command> --profile <profile> [--patch <p>]... <prompt>`。

## 运行记录

`<ledgerRoot>/<experiment>/experiment.json` 锁定实验定义；用不同的定义重新打开同一账本会被拒绝。`runs.jsonl` 每行一条记录，带 `formatVersion: 1`；读取方遇到其他版本一律拒绝，崩溃留下的残缺末行会被丢弃。每条记录包含 `cell`、`status`、`grade` 和 `grader`（kind 与版本）、`metrics`、`exitCode`、`error`、`models`、`suiteVersion`、`startedAt` 和 `endedAt`。

| 状态 | 含义 |
|---|---|
| `graded` | 子进程已退出，评分器已依据工作区和根会话日志评分。 |
| `timeout` | 子进程超过 `runTimeoutMs` 被杀，不评分。若子进程已持久化会话，则带有 `metrics`。 |
| `invalid` | 无法测量：home 中没有恰好一个顶层会话，或评分器抛错。不计入成功率。 |

指标来自经 JSONL 持久化后端读取的会话。token 和成本对全部会话求和，包括 subagent 子会话；`tokens.input` 不含缓存命中。轮数、步数、重试和工具统计只描述根会话。`timing` 把根会话墙钟时间拆成三部分：`llmMs`（`step/start` → `assistant/message`）、`toolCriticalMs`（每步最慢的那次工具调用，因为并行调用会重叠）和 `overheadMs`（其余时间，即 harness 和插件耗时）。只有用到的每个模型都在 `prices` 中有对应行时，记录才带 `costUsd`。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | 必填 | 启动器 argv 前缀，例如 `[node, /abs/apps/cli/lib/bin.js]`。只能用构建产物，因为子进程以普通 Node 运行。 |
| `templateHome` | 必填 | 用其 profile 为每个运行 home 播种的 home 目录。 |
| `templateFiles` | 必填 | 复制进每个运行 home 的文件（相对 home），例如 `credentials.yaml`。 |
| `ledgerRoot` | 必填 | 存放各实验账本的目录，每个实验一个账本。 |
| `concurrency` | `1` | 同时进行的运行数。 |
| `runTimeoutMs` | `600000` | 单次运行的墙钟时限。 |
| `prices` | `[]` | `{ model, input, output, cacheRead? }`，单位为美元每百万 token。 |

## 模型体验

通过 `dsh-headless` 间接影响；它在隔离的子进程中把每个任务 prompt 作为本次运行唯一的一条用户消息发送。

#### KV Cache 影响

不会直接导致 KV Cache 失效；每次运行都是独立进程中的独立会话，运行之间不共享请求前缀。

## 已知局限与延后工作

- **尚无分析** — 记录只保存每次运行的原始数据；相对基线的配对差值、置信区间和瓶颈排名随分析层提供。
- **patch 内容未锁定** — `experiment.json` 锁定的是 patch 路径而非内容，因此在两次续跑之间修改 patch 文件，会让同一个 variant id 下混入两种组合。
- **运行目录会保留** — 工作区和 home 留在磁盘上供检查，从不清理。
- **`$DSH_HOME` 之外的插件状态需要 variant `env` 条目** — 若插件写入 `~` 且没有覆盖变量（例如 `MNEMON_DATA_DIR`），其状态会在各次运行之间共享。
