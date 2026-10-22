# Cookbook：添加 benchmark

[English](adding-a-benchmark.md) | 中文

一个 benchmark 就是一个注册到 `ctx.benchmarks`（[`dsh-bench`](../../packages/bench/bench/README.md)）的套件插件。运行器、账本和后续的分析都不需要修改。模板是 `packages/bench/bench-suite-dsh-native`。

## 1. 选择形式

- **声明式套件（无需代码）**：每个任务都能用内置评分器评分时使用。内置评分器有 `command-exit`（在工作区中运行检查命令）、`file-contains` 和 `session-event`（统计工具调用次数）。大多数 benchmark 只要把数据集一次性转换成 `tasks.jsonl` 和 fixture 目录就能套用。
- **带自定义评分器的套件**：评分需要写代码时使用，例如比较工具调用参数。任务仍用声明式数据，评分器用 `ctx.benchmarks.registerGrader(...)` 与套件一起注册。评分器要有 `version`，只要同一份规格的评分结果会变，就必须递增版本。

## 2. 创建包

把 `packages/bench/bench-suite-dsh-native` 复制为 `packages/bench/bench-suite-<name>`，并重命名包名、插件 `name` 和 invariant companion。在 `tsconfig.host.json` 中注册该包，把它加到 [`packages/bench/README.md`](../../packages/bench/README.md)，再在 `scripts/verify-package-readme-model-experience.ts` 中加一条 sentence 条目。通用的包清单见[添加包](adding-a-package.md)。

## 3. 编写套件数据

- `suite/suite.yml`：`id`、`version`、`description`。prompt、fixture 或评分器规格有任何变化时都要修改 `version`，避免不同任务内容的运行被合并统计。
- `suite/tasks.jsonl`：每行一个任务，字段为 `id`、`prompt`、可选的 `fixture`（`suite/` 下的目录）、`grader` 和 `tags`。
- `suite/fixtures/<task>/`：任务的初始工作区。agent 结束后评分器在工作区内运行，所以检查脚本要放在 fixture 里。

使用外部数据集时，在包 README 中记录来源、版本和许可证，并把转换脚本放在包内的 `scripts/` 下，以便重新生成数据。只使用能在本机以程序化方式评分的数据集。每个任务都需要 Docker、依赖托管环境或依赖 LLM 评审的数据集不在范围内。

## 4. 验证评分器

`tests/conformance.spec.ts` 调用 [`dsh-bench-testkit`](../../packages/test-support/bench-testkit/README.md) 中的 `describeSuiteConformance`，为每个任务提供一次应通过和一次应失败的模拟运行。评分器若区分不了二者，测试就会失败。另外加一个 Loader 组合测试，加载该套件行并列出它的任务 id。

## 5. 运行

在任何付费运行之前，先用无需密钥的 mock 模型跑一个小实验：启动 `pnpm run mock:llm`，把 `DEEPSEEK_BASE_URL` 指向它，然后用一次重复、两个 variant，通过 [benchmark 命令](../../packages/bundle/benchmarks/README.md)（`node apps/cli/lib/bin.js --profile bench experiment.yml --yes`）运行实验。确认每次运行的结果都是通过或失败，而不是无法测量。对真实模型的付费运行，必须先让成本获得批准，并设置 `--max-usd`。
