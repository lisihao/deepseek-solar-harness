# `@deepseek-ai/dsh-benchmarks`

[English](README.md) | 中文

可选启用的 benchmark bundle。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：它关闭 HMR，并插入以下几行：benchmark 注册表（[`dsh-bench`](../../bench/bench/README.md)）、`dsh-native` 套件、运行器（[`dsh-bench-runner`](../../bench/bench-runner/README.md)），以及本包自己的两行。其中 `bench-startup`（[`src/startup.ts`](src/startup.ts)）负责解析命令行，`bench-cli` 负责运行一个实验，并通过 `ctx.appExit`（[`dsh-cmdline`](../../boot/cmdline/README.md)）请求退出。它不挂载 Host、HTTP 服务器或浏览器插件。

## 准备

新建一个 profile，bundles 填 dsh-base 和本 bundle。它与实验运行时启动的 profile（通常是 `headless`）放在同一目录下：

```json
{ "name": "dsh-profile-bench", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-benchmarks"] } } }
```

把它保存为 `$DSH_HOME/profiles/bench/package.json`。每次运行都会把 `$DSH_HOME/profiles/<实验的 profile>` 复制进该次运行的私有 home。模型凭据从 `DEEPSEEK_API_KEY` 读取，或者从复制进去的 `$DSH_HOME/.credentials.yaml` 读取。结果记录到 `$DSH_HOME/bench/<实验 id>/`。

## 命令

```sh
node apps/cli/lib/bin.js --profile bench ./experiment.yml          # print the plan
node apps/cli/lib/bin.js --profile bench ./experiment.yml --yes    # run it
node apps/cli/lib/bin.js --profile bench ./experiment.yml --yes --max-usd 2
```

- **运行计划**：命令先打印套件及版本、任务 × variant × 重复次数的总运行数（含已记录的运行数）、各 variant 的 patch，以及花费上限。
- **凭据检查**：`DEEPSEEK_API_KEY` 和 `$DSH_HOME/.credentials.yaml` 都不存在时，在任何运行开始前以 1 退出。
- **需要确认**：不带 `--yes` 时以 2 退出，不做任何运行，因为运行会调用配置的模型，可能产生费用。
- **运行过程**：带上 `--yes` 后，每完成一次运行打印一行结果（通过、失败、超时，或无法测量及原因）。结束后依次打印：有价格运行的花费、各 variant 的汇总表，以及每个对比与基线相比的一句白话结论。
- **花费上限**：`--max-usd` 会在有价格运行的花费超过该金额后中止实验。
- **中止与续跑**：中止或按 Ctrl-C 后，命令以 1 退出，已记录的运行保留；再次执行同一命令会从中断处继续。
- **只能用构建产物启动**：子运行会重新执行本进程的启动器，因此拒绝从源码启动（`pnpm dsh` 或 `.ts` 入口）。原因是 TypeScript loader 无法传给子进程，而且运行必须测量构建产物。

实验文件格式见 [`dsh-bench-runner`](../../bench/bench-runner/README.md#experiments)。

## 配置

可以在 profile 的 `cordis.patch.yml` 中覆盖某一行，例如加上模型价格。注意：按 id 指定的 `config` 会整体替换该行的配置，所以每个键都要重新写一遍：

```yaml
- id: bench-runner
  config:
    command: !!js ctx.benchStartup.launcher
    templateHome: !!js dshHomePath()
    templateFiles: [.credentials.yaml]
    ledgerRoot: !!js dshHomePath('bench')
    prices:
      - { model: deepseek-v4-flash, input: 0.27, output: 1.1, cacheRead: 0.07 }
```

`bench-cli` 的配置项如下：
- `experiment`、`confirmed` 和 `maxUsd` 取自 `ctx.benchStartup`。
- `credentials` 包含 `env` 变量名和 `files` 路径，运行开始前至少要有一个存在。
- `analysis` 即[分析设置](../../bench/bench-runner/README.md#analysis)，带默认值。

## 模型体验

通过 `dsh-bench-runner` 间接影响：它的子运行把每个任务 prompt 作为一个隔离 `dsh-headless` 会话中唯一的用户消息发送。

#### KV Cache 影响

不会直接导致 KV Cache 失效；每次运行都是独立进程中的全新会话。

## 已知局限与延后工作

- **运行前没有成本预估**：运行计划只给出运行数量，不给出金额；`--max-usd` 只在有价格的运行结束后才生效，所以停止前的最后一次运行可能使花费超过上限。
- **profile 需要手动创建**：`dsh plugin` 没有内置的 `bench` 模板，上面的 profile `package.json` 需要手写。
- **只识别 DeepSeek 凭据**：凭据检查只认 `DEEPSEEK_API_KEY` 和本地凭据文件；使用其他 provider 时需要覆盖 `credentials`。
