# @deepseek-ai/dsh-bench-testkit

English | [中文](README.zh.md)

Conformance kit for benchmark suites. A suite package's test calls `describeSuiteConformance({ suite, graders?, runs })`, with one simulated passing run and one failing run per task. The kit registers a vitest case asserting `checkSuiteConformance` reports nothing.

`checkSuiteConformance` reports:

- a suite that fails to load or has no tasks;
- a duplicate task id;
- a fixture that is not a directory;
- a grader kind that is not built in or listed in `graders`;
- a spec rejected by its grader's `validate`;
- a task without runs, and runs naming no task;
- a grader that fails the passing run or passes the failing one.

A simulated run is `{ files?, events? }`: workspace files written over a copy of the task fixture, and the session log the grader sees. Each run is graded in a fresh scratch workspace.

## Model Experience

None, as the kit grades simulated runs in scratch directories and never builds a model request.

#### KV Cache effect

None; the kit never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Graders only** — the kit checks suite data and graders, not whether a model can solve a task; a keyless runner experiment covers execution.
