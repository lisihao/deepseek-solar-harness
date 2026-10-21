# Agent Note: Benchmarks are ablation experiments over isolated runs

Status: implemented

English | [中文](2026-10-21-benchmark-ablation-ledger.zh.md)

## Problem

DSH grows by plugins, and nothing showed whether a plugin, a combination of plugins, or a flow built from plugins makes the system better or only adds tokens and latency. A leaderboard score for one composition cannot answer that: the answer is a difference between compositions on the same tasks.

## Decision

A benchmark is an experiment: a suite's tasks × variants × repetitions. A variant is a profile plus ordered `--patch` overlays plus environment, so "baseline + plugin X" is expressed with the composition mechanism DSH already has. The first variant is the baseline that later analysis compares against.

Each run is a separate `dsh` child process with a fresh workspace, a private `$DSH_HOME` seeded from a template home, and a private state directory that variant environment entries can point outside-home plugin state at. Without this, memory-style plugins would carry state between repetitions and between variants, and the measured difference would be contaminated. The child is the real product entry (`dsh --profile <profile>`), so the measured system is the shipped one.

Results are the session logs DSH already writes. The runner reads them through the JSONL persistence backend and folds tokens, cost, turns, steps, tools, retries, and a time split (model, slowest tool per step, remainder as harness overhead). No new session event or in-process instrumentation is needed, and the measured runs carry no benchmark code.

Every run appends one record to `runs.jsonl` with `formatVersion: 1`; `experiment.json` pins the definition. The ledger doubles as the experiment state: a cell with a record is done, so a crashed or cancelled experiment resumes, and a changed definition must use a new experiment id rather than mix populations.

Benchmarks are added as suite plugins registering into `ctx.benchmarks`. Most suites are declarative data (`suite.yml`, `tasks.jsonl`, fixtures) graded by built-in graders; a suite with custom grading registers its own grader. A conformance kit requires each task to come with a passing and a failing run, so a grader that passes everything cannot ship.

## Alternatives considered

**Run variants inside one process.** It is faster, but plugin state, module caches, and services would leak across variants, and per-variant plugin loading would differ from what users boot.

**Instrument plugin hooks for per-plugin timing.** It needs a hook in every extension point and still would not capture what context-injecting plugins cost in prompt tokens. The ablation difference attributes the whole effect of a plugin, including tokens.

**A database for results.** An append-only JSONL file per experiment is enough for the volumes involved, is readable without tooling, and survives crashes with at most one torn line.

## Consequences

Analysis (paired differences against the baseline, intervals, minimum detectable effect, bottleneck ranking) and the Desktop panel consume the ledger without touching runs. Multi-turn tasks and warm-up sessions need an ACP driver beside the headless one. Patch file contents are not pinned in `experiment.json`, so editing a patch between resumed runs mixes compositions under one variant id.
