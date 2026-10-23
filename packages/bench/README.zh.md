# bench/ — 插件基准测试

[English](README.md) | 中文

用于测量插件、插件组合以及由插件搭建的业务流是否真正提升了 DSH。一个实验会在多种组合（variant）下按重复次数运行某个套件的全部任务，每次运行都在独立隔离的 `dsh` 子进程中进行，并逐次记录评分、token、成本和耗时。套件本身就是插件，因此新增一个 benchmark 就是新增一个套件包，通常只需声明式数据（[cookbook](../../docs/cookbook/adding-a-benchmark.md)）。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`bench/`](bench/README.md) | 定义套件、任务和评分器，并提供声明式套件格式与内置评分器 | `ctx.benchmarks` |
| [`bench-runner/`](bench-runner/README.md) | 以隔离子进程运行实验并维护运行账本 | `ctx.benchRuntime` |
| [`bench-suite-dsh-native/`](bench-suite-dsh-native/README.md) | 注册 `dsh-native` 编码套件 | 注册到 `ctx.benchmarks` |
| [`bench-web/`](bench-web/README.md) | 通过 Host Web 服务器提供账本及其分析 | 读取 `ctx.benchRuntime` |

套件测试使用的一致性工具包是 [`test-support/bench-testkit`](../test-support/bench-testkit/README.md)。设计决策见 [benchmark 账本决策](../../.agents/notes/implemented/architecture/2026-10-21-benchmark-ablation-ledger.md)。
