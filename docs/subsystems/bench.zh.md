# Benchmarks

[English](bench.md) | 中文

benchmark 能力用于测量某个插件、插件组合或由插件搭成的流程到底改变了什么。[`ctx.benchmarks`](../../packages/bench/bench/README.md) 是套件和评分器的注册表，由套件插件向其中注册。[`ctx.benchRuntime`](../../packages/bench/bench-runner/README.md) 运行实验，即每个（variant、任务、重复次）组合，每次运行都是一个相互隔离的 `dsh` 子进程，并为每次运行向实验账本追加一条记录。[消融账本决策](../../.agents/notes/implemented/architecture/2026-10-21-benchmark-ablation-ledger.md)说明了为什么每次运行都是独立进程，以及为什么账本本身就是实验状态。

## 数据流

1. 套件插件在 `ctx.benchmarks` 上注册 `BenchSuite`，如有自定义评分器也一并注册 `BenchGrader`。声明式套件由 `loadDeclarativeSuite(dir)` 生成。
2. `ctx.benchRuntime.run(experiment)` 加载套件的任务，并在任何运行开始前校验所有评分器规格。
3. 每个待运行的 cell 都会获得全新的工作区、私有的 `$DSH_HOME` 和状态目录。子进程 `dsh --profile <profile> [--patch …] <prompt>` 以单轮方式运行该任务。
4. 运行器通过 JSONL 持久化后端读取子进程的会话，依据工作区和根会话日志评分，折叠出指标，并追加一条 `RunRecord`。
5. [`dsh-bench-web`](../../packages/bench/bench-web/README.md) 通过 `ctx.benchRuntime.ledger(id)` 读取账本，并结合 `analyzeExperiment` 对外提供：每个 variant 的汇总，以及相对基线的配对对比和判定。

添加套件无需改动运行器（[cookbook](../cookbook/adding-a-benchmark.md)）；[`dsh-bench-testkit`](../../packages/test-support/bench-testkit/README.md) 负责检查每个评分器能否区分应通过的运行和应失败的运行。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbenchmarks--benchregistry"></a>

### `ctx.benchmarks` — `BenchRegistry`

Registry of benchmark suites and graders. Each registration is an effect on the calling context's fiber, so unloading a suite plugin removes its suites and graders. Duplicate suite ids and grader kinds are refused; built-in graders occupy their kinds for the registry's lifetime.

```ts cordis-catalog
/**
 * Register a suite under its id.
 * @param suite - the suite; its id must not already be registered.
 * @returns the disposer that unregisters it.
 */
registerSuite(suite: BenchSuite): () => void

/**
 * Register a grader under its kind.
 * @param grader - the grader; its kind must not already be registered.
 * @returns the disposer that unregisters it.
 */
registerGrader(grader: BenchGrader): () => void

/**
 * Look up a suite.
 * @param id - suite id.
 * @returns the suite, or `undefined` when none is registered under `id`.
 */
suite(id: BenchSuiteId): BenchSuite | undefined

/**
 * List registered suites.
 * @returns the suites in registration order.
 */
suites(): BenchSuite[]

/**
 * Look up a grader.
 * @param kind - grader kind.
 * @returns the grader, or `undefined` when none is registered under `kind`.
 */
grader(kind: string): BenchGrader | undefined
```

Source: [`packages/bench/bench/src/index.ts:32`](../../packages/bench/bench/src/index.ts)

<a id="ctxbenchruntime--benchruntime"></a>

### `ctx.benchRuntime` — `BenchRuntime`

Runs benchmark experiments as isolated child processes.

```ts cordis-catalog
/**
 * Run every unrecorded cell of an experiment. Cells are ordered by
 * repetition, then task, then variant, so a partial experiment stays
 * balanced across variants.
 * @param experiment - the experiment to run.
 * @param options - cancellation and progress.
 * @returns every record in the ledger after the run, earlier ones included.
 * @throws Error before any run starts when `command` is empty, when the suite, a task,
 *   or a grader spec is invalid, or when the ledger pins a different definition; the abort reason when cancelled.
 */
async run(experiment: Experiment, options: RunOptions = {}): Promise<RunRecord[]>

/**
 * List the experiments that have a ledger.
 * @returns their ids in name order.
 */
experiments(): Promise<ExperimentId[]>

/**
 * Read one experiment's pinned definition and records without modifying the ledger.
 * @param id - experiment id.
 * @returns the snapshot, or `undefined` when no ledger exists under `id`.
 */
async ledger(id: string): Promise<LedgerSnapshot | undefined>
```

Source: [`packages/bench/bench-runner/src/index.ts:123`](../../packages/bench/bench-runner/src/index.ts)
<!-- END GENERATED cordis-surface -->
