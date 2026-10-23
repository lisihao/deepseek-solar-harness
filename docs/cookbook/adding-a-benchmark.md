# Cookbook: adding a benchmark

English | [中文](adding-a-benchmark.zh.md)

A benchmark is a suite plugin that registers into `ctx.benchmarks` ([`dsh-bench`](../../packages/bench/bench/README.md)). The runner, ledger, and later analysis need no change. `packages/bench/bench-suite-dsh-native` is the template.

## 1. Choose the form

- **Declarative suite (no code)** — use it when every task can be graded by a built-in grader: `command-exit` (a check command in the workspace), `file-contains`, or `session-event` (tool-call counts). Most benchmarks fit after a one-time conversion of their dataset into `tasks.jsonl` and fixture directories.
- **Suite with its own grader** — use it when grading needs code, for example comparing tool-call arguments. Keep the tasks declarative and register the grader beside the suite with `ctx.benchmarks.registerGrader(...)`. Give it a `version` and bump the version whenever an unchanged spec would grade differently.

## 2. Create the package

Copy `packages/bench/bench-suite-dsh-native` to `packages/bench/bench-suite-<name>` and rename the package, the plugin `name`, and the invariant companion. Register the package in `tsconfig.host.json`, add it to [`packages/bench/README.md`](../../packages/bench/README.md), and add a sentence entry to `scripts/verify-package-readme-model-experience.ts`. The general package checklist is [adding a package](adding-a-package.md).

## 3. Write the suite data

- `suite/suite.yml`: `id`, `version`, `description`. Change `version` whenever a prompt, fixture, or grader spec changes, so runs on different task contents are never pooled.
- `suite/tasks.jsonl`: one task per line, with `id`, `prompt`, optional `fixture` (a directory under `suite/`), `grader`, and `tags`.
- `suite/fixtures/<task>/`: the starting workspace. Graders run inside the workspace after the agent finishes, so check scripts live in the fixture.

For an external dataset, record its source, revision, and license in the package README, and keep the conversion script under `scripts/` in the package so the data can be regenerated. Use only datasets that grade programmatically on a local machine. Datasets needing Docker per task, hosted environments, or LLM judges are out of scope.

## 4. Prove the graders

`tests/conformance.spec.ts` calls `describeSuiteConformance` from [`dsh-bench-testkit`](../../packages/test-support/bench-testkit/README.md) with one passing and one failing simulated run per task. A grader that cannot tell them apart fails the test. Add a Loader composition test that boots the suite row and lists its task ids.

## 5. Run it

Run a small experiment against the keyless mock model before any paid run: start `pnpm run mock:llm`, point `DEEPSEEK_BASE_URL` at it, and run the experiment through the [benchmark command](../../packages/bundle/benchmarks/README.md) (`node apps/cli/lib/bin.js --profile bench experiment.yml --yes`) with one repetition and two variants. Check that every run is pass or fail rather than unmeasurable. A paid run against a real model needs its cost approved first; set `--max-usd`.
