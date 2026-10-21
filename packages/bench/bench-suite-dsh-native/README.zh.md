# @deepseek-ai/dsh-bench-suite-dsh-native

[English](README.md) | 中文

这是一个函数插件，向 `ctx.benchmarks` 注册 `dsh-native` benchmark 套件。套件由基于 DSH 自身工具面的编码任务组成，以声明式数据存放在 `suite/` 下（`suite.yml`、`tasks.jsonl`、`fixtures/`）。它也是“以数据形式添加套件”的参考示例（[cookbook](../../../docs/cookbook/adding-a-benchmark.md)）。

## 任务

| Id | 标签 | 评分方式 |
|---|---|---|
| `fix-sum-bug` | `code` | agent 修复 `sum.js` 中循环少算一位的错误后，`node test.js` 以 0 退出 |
| `count-lines` | `files` | `node check.js` 接受写入 `answer.txt` 的行数 |
| `shell-listing` | `tools` | 会话日志中至少有一次 `bash` 调用 |

评分命令使用 `PATH` 中的 `node`。`tests/conformance.spec.ts` 为每个任务各提供一次应通过和一次应失败的运行；评分器若区分不了二者，构建就会失败。

## 组合

```yaml
- id: bench-suite-dsh-native
  name: '@deepseek-ai/dsh-bench-suite-dsh-native'
```

注入 `benchmarks`。

## 模型体验

通过 `dsh-bench-runner` 间接影响；它把 `suite/tasks.jsonl` 中每个任务的 `prompt` 作为一次隔离 benchmark 运行中唯一的用户消息发送。

#### KV Cache 影响

不会直接导致 KV Cache 失效；每次 benchmark 运行都是一个全新会话。

## 已知局限与延后工作

- **目前只有种子任务** — 共三个任务；记忆、编排和可靠性类任务需要多轮脚本和故障注入，运行器尚不支持。
