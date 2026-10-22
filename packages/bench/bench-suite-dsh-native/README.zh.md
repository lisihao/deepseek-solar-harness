# @deepseek-ai/dsh-bench-suite-dsh-native

[English](README.md) | 中文

这是一个函数插件，向 `ctx.benchmarks` 注册 `dsh-native` benchmark 套件。套件由基于 DSH 自身工具面的编码任务组成，以声明式数据存放在 `suite/` 下（`suite.yml`、`tasks.jsonl`、`fixtures/`）。它也是“以数据形式添加套件”的参考示例（[cookbook](../../../docs/cookbook/adding-a-benchmark.md)）。

## 任务

| Id | 标签 | 评分方式 |
|---|---|---|
| `fix-sum-bug` | `code` | agent 修复 `sum.js` 中循环少算一位的错误后，`node test.js` 以 0 退出 |
| `count-lines` | `files` | `node check.js` 接受写入 `answer.txt` 的行数 |
| `shell-listing` | `tools` | 会话日志中至少有一次 `bash` 调用 |
| `rename-function` | `code`、`refactor` | `node check.js`：所有文件都不再出现 `calcTotal`，且 `computeTotal` 行为不变 |
| `fix-range` | `code` | 修复 `range.js` 起点少算一位的错误后，`node test.js` 通过 |
| `json-port` | `files` | `node check.js`：`config.json` 的端口为 8080，其余键不变 |
| `count-todos` | `files`、`search` | `node check.js` 接受 `src/` 下大写 `TODO` 标记的数量（5） |
| `is-palindrome` | `code` | 按注释实现 `isPalindrome` 后，`node test.js` 通过 |
| `missing-await` | `code` | 在 `user.js` 中补上缺失的 `await` 后，`node test.js` 通过 |
| `csv-sum` | `files` | `node check.js` 接受 `qty` 列之和（43） |
| `validate-input` | `code` | `node test.js`：`square` 对非有限数输入抛出 `TypeError` |
| `locate-definition` | `search`、`code` | 在干扰性提及中找出定义所在文件，`node check.js` 接受 `src/lib/http/headers.js` |
| `fix-import` | `code` | `node check.js`：修复导入路径后 `node main.js` 输出 `[ok]` |
| `sort-by-age` | `code` | 替换返回布尔值的比较函数后 `node test.js` 通过，且不修改输入 |

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

- **只有单轮编码任务** — 共十四个任务，达到默认的 `minTasks`（10）；记忆、编排和可靠性类任务需要多轮脚本和故障注入，运行器尚不支持。
