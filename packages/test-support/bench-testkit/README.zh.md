# @deepseek-ai/dsh-bench-testkit

[English](README.md) | 中文

benchmark 套件的一致性检查工具包。套件包在测试中调用 `describeSuiteConformance({ suite, graders?, runs })`，为每个任务提供一次应通过和一次应失败的模拟运行。工具包会注册一个 vitest 用例，断言 `checkSuiteConformance` 没有报告任何问题。

`checkSuiteConformance` 报告以下问题：

- 套件加载失败或没有任务；
- 任务 id 重复；
- fixture 不是目录；
- 评分器 kind 既非内置，也未列在 `graders` 中；
- 规格被其评分器的 `validate` 拒绝；
- 任务缺少运行，或运行指向不存在的任务；
- 评分器判定应通过的运行失败，或判定应失败的运行通过。

模拟运行的形式是 `{ files?, events? }`：`files` 是写在任务 fixture 副本之上的工作区文件，`events` 是评分器看到的会话日志。每次运行都在全新的临时工作区中评分。

## 模型体验

无，因为工具包只在临时目录中为模拟运行评分，从不构建模型请求。

#### KV Cache 影响

无；工具包从不组装或发送 provider 请求。

## 已知局限与延后工作

- **只检查评分器** — 工具包检查的是套件数据和评分器，而不是模型能否完成任务；实际执行由无密钥的运行器实验覆盖。
