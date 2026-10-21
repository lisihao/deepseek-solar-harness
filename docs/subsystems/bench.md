# Benchmarks

English | [中文](bench.zh.md)

The benchmark capability measures what a plugin, plugin combination, or plugin-built flow changes. [`ctx.benchmarks`](../../packages/bench/bench/README.md) is the registry of suites and graders that suite plugins contribute to. [`ctx.benchRuntime`](../../packages/bench/bench-runner/README.md) runs an experiment — every (variant, task, repetition) — as isolated `dsh` child processes and appends one record per run to the experiment ledger. The [ablation-ledger decision](../../.agents/notes/implemented/architecture/2026-10-21-benchmark-ablation-ledger.md) records why runs are separate processes and why the ledger is the experiment state.

## Data flow

1. A suite plugin registers a `BenchSuite` (and any custom `BenchGrader`) on `ctx.benchmarks`. Declarative suites come from `loadDeclarativeSuite(dir)`.
2. `ctx.benchRuntime.run(experiment)` loads the suite's tasks and validates every grader spec before any run starts.
3. Each pending cell gets a fresh workspace, private `$DSH_HOME`, and state directory. The child `dsh --profile <profile> [--patch …] <prompt>` runs the task as one turn.
4. The runtime reads the child's sessions through the JSONL persistence backend, grades the workspace and root session log, folds metrics, and appends the `RunRecord`.

Suites are added without touching the runtime ([cookbook](../cookbook/adding-a-benchmark.md)); [`dsh-bench-testkit`](../../packages/test-support/bench-testkit/README.md) checks that each grader separates a passing run from a failing one.

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
 * @throws Error before any run starts when the suite, a task, or a grader spec is invalid,
 *   or when the ledger pins a different definition; the abort reason when cancelled.
 */
async run(experiment: Experiment, options: RunOptions = {}): Promise<RunRecord[]>
```

Source: [`packages/bench/bench-runner/src/index.ts:87`](../../packages/bench/bench-runner/src/index.ts)
<!-- END GENERATED cordis-surface -->
