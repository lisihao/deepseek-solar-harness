# Agent Note: Solar governance critical path

Status: implemented

English | [中文](2026-08-20-solar-governance-critical-path.zh.md)

## Problem

Solar governance repeated the same TypeScript source preparation in typecheck, lint, documentation, and web-build gates. The complete related-test gate then ran 833 files with one worker. On GitHub's macOS runner it consumed 757 seconds, while documentation synchronization consumed another 173 seconds and the complete governance job approached 20 minutes. The same commit could also start both pull-request CI and the fork's full push adapter.

Two native HMR suites occasionally lost filesystem events only inside the long, shared 833-file run. Thirty focused repetitions passed, and direct Chokidar experiments confirmed that ancestor watching is required for an initially missing exact path. The evidence therefore identified shared native-watcher pressure, not an insufficient timeout or incorrect application behavior.

The first optimized pull-request run exposed a second resource boundary: the three-CPU macOS runner multiplied three outer governance gates by their inner worker pools. The read-card suite's dynamic imports of every lazy Shiki grammar then exceeded its unchanged five-second responsiveness contract, while 13,588 other tests passed. This was nested parallelism oversubscription, not missing coverage or a reason to increase the timeout.

The Solar repository has no registered custom runners or failover variables. Three required Linux jobs and the independent native Windows job inherited organization-only runner labels from upstream and remained queued for more than two hours without receiving a runner. That latency was unbounded allocation wait, not build execution.

After moving those jobs to standard four-core runners, the coverage lane exposed one final nested budget: its instrumented and exempt suites each used one worker, while the Oxlint responsiveness contract spawned child processes under the remaining shared CPU pressure. Limiting Oxlint itself to one thread was insufficient: the contract's final-diagnostics case still reached 5.228 seconds against its unchanged five-second limit, while the instrumented coverage suite and the other 216 exempt tests passed.

## Decision

The Solar profile is a bounded dependency graph with `max_concurrency: 2`. This leaves one CPU available for child-process pools on the three-CPU GitHub macOS runner instead of multiplying three top-level gates by three inner workers. A single `source-build` gate prepares shared TypeScript outputs. Typecheck, lint, documentation synchronization, and web build consume those outputs through their `*:contracts-ready` entry points and declare `needs: [source-build]`. The governance runtime expands transitive dependencies, schedules only ready gates, and blocks a consumer when its dependency fails.

Vitest owns its worker budgets in project configuration: thread-safe tests use at most three workers and process-bound tests use one. The two native HMR suites and the CPU-bound read-card lazy-grammar suite run only in the process-bound project; their behavior and timeouts are unchanged. The grammar suite must preserve its existing five-second responsiveness contract while the outer governance DAG is active. Related-test selection remains `vitest run --changed=origin/solar`, so the governance profile does not override project-level isolation.

The workflow uses a partial blob checkout, pnpm and Yarn caches, and cancellation of superseded runs. Required Solar pull-request jobs default to portable `ubuntu-24.04` and `windows-2025` runners, with their inner concurrency bounded for standard four-core capacity. The existing repository-variable selectors still permit an explicitly configured self-hosted pool, but normal correctness no longer depends on upstream organization runner labels. Pull-request CI remains the automatic commit-bound authority. The complete [fork adapter](2026-08-15-fork-branch-push-ci.md) remains available through manual dispatch for cross-platform diagnosis, but no longer duplicates every `codex/**` branch push.

The coverage lane additionally fixes `DSH_OXLINT_THREADS=1` and moves only `scripts/oxlint-contract.spec.ts` into a dependent tail gate. The instrumented and remaining exempt suites still run concurrently; after both finish, the Oxlint responsiveness contract runs on the idle runner. This adds only the focused tail rather than serializing the two long coverage paths. Test selection, coverage thresholds, and the five-second contract are unchanged.

## Alternatives considered

**Increase HMR timeouts.** Rejected because focused stress passed and the failure was event loss under aggregate watcher pressure; waiting longer would hide rather than remove contention.

**Use polling or allow empty project selections.** Rejected because polling adds constant filesystem load and `--passWithNoTests` could turn an incorrect test partition into apparent success.

**Skip complete Code-as-Harness verification.** Rejected because optimization must preserve the same attested gate set and evidence semantics.

**Run both automatic fork push CI and pull-request CI.** Rejected because they repeat the same full evidence for one commit. The manual adapter preserves the diagnostic matrix without taxing the normal path.

## Consequences

Independent gates use a two-slot outer budget, while native-watcher and lazy-grammar tests remain serialized inside Vitest. Gate output is emitted after each task completes, so concurrent logs remain readable. Standard runner lanes may execute longer than organization-specific larger runners, but they start without external runner provisioning and keep the public repository reproducible. A branch push without a pull request no longer receives the fork adapter's automatic verdict; opening or updating a pull request supplies the required authority, and the diagnostic matrix can still be dispatched manually.

## Verification

Contract tests pin the shared build dependency, prepared consumer commands, exact related-test command, worker budgets, partial checkout, caches, and absence of a second workflow-level source build. Governance runtime tests cover invalid and cyclic dependencies, transitive selection, bounded independent execution, and dependency failure. Acceptance requires the full strict audit, monorepo verifier, complete Code-as-Harness verification and attestation, followed by the remote pull-request CI verdict for the exact commit.
