# Agent Note: Solar governance critical path

Status: implemented

English | [中文](2026-08-20-solar-governance-critical-path.zh.md)

## Problem

Solar governance repeated the same TypeScript source preparation in typecheck, lint, documentation, and web-build gates. The complete related-test gate then ran 833 files with one worker. On GitHub's macOS runner it consumed 757 seconds, while documentation synchronization consumed another 173 seconds and the complete governance job approached 20 minutes. The same commit could also start both pull-request CI and the fork's full push adapter.

Two native HMR suites occasionally lost filesystem events only inside the long, shared 833-file run. Thirty focused repetitions passed, and direct Chokidar experiments confirmed that ancestor watching is required for an initially missing exact path. The evidence therefore identified shared native-watcher pressure, not an insufficient timeout or incorrect application behavior.

The first optimized pull-request run exposed a second resource boundary: the three-CPU macOS runner multiplied three outer governance gates by their inner worker pools. The read-card suite's dynamic imports of every lazy Shiki grammar then exceeded its unchanged five-second responsiveness contract, while 13,588 other tests passed. This was nested parallelism oversubscription, not missing coverage or a reason to increase the timeout.

The Solar repository has no registered custom runners or failover variables. Three required Linux jobs and the independent native Windows job inherited organization-only runner labels from upstream and remained queued for more than two hours without receiving a runner. That latency was unbounded allocation wait, not build execution.

After moving those jobs to standard four-core runners, the coverage lane exposed one final nested budget: its instrumented and exempt suites each used one worker, while the Oxlint responsiveness contract spawned child processes under the remaining shared CPU pressure. Limiting Oxlint itself to one thread was insufficient: the contract's final-diagnostics case still reached 5.228 seconds against its unchanged five-second limit, while the instrumented coverage suite and the other 216 exempt tests passed.

The first complete standard-runner consumer lane exposed the same distinction between logical independence and resource independence. Four outer consumer gates plus Vitest's unconstrained snapshot file workers starved a 150 ms keep-alive contract into an unwanted provider retry. Separately, a scroll scenario's 120 paced chunks completed before its deliberately expensive history-and-anchor setup, so the fixture no longer established the concurrency it intended to test. Both focused scenarios passed when isolated.

After those resource budgets were fixed, all 76 ordinary browser files and the revised scroll contract passed remotely, but the Cordis dynamic-plugin lifecycle ended its second turn with an error only after sharing the long-lived Vitest process with the preceding browser suite. The complete 77-file lane and the focused Cordis file both passed locally, identifying cross-file process state rather than a product or golden change.

The final macOS governance run showed that worker bounds alone do not make a machine-wide gate resource-independent. While `related-tests` overlapped source build and documentation work, three unrelated timing contracts failed across HMR configuration, Oxlint diagnostics, and ACP persistence, although 824 of 832 files passed and the exact suite passed locally. The shared signal was outer-gate contention, so changing those product timeouts would have hidden the scheduler defect.

The first native run on standard Windows also made an inherited platform boundary visible. Three suites attempted to bind Unix-domain socket paths, a POSIX mode assertion compared Windows' synthesized bits, and two integration fixtures exhausted default test-harness timing while the complete instrumented inventory was active. These were not Windows product regressions: the local orchestration and Resident authorities have no named-pipe transport, and the repository already maintains an explicit Windows-unsupported test roster.

## Decision

The Solar profile is a bounded dependency graph with `max_concurrency: 2`. This leaves one CPU available for child-process pools on the three-CPU GitHub macOS runner instead of multiplying three top-level gates by three inner workers. A single `source-build` gate prepares shared TypeScript outputs. Typecheck, lint, documentation synchronization, and web build consume those outputs through their `*:contracts-ready` entry points and declare `needs: [source-build]`. The governance runtime expands transitive dependencies, schedules only ready gates, and blocks a consumer when its dependency fails.

Vitest owns its worker budgets in project configuration: thread-safe tests use at most two workers and process-bound tests use one. Both projects run concurrently, so this three-worker aggregate leaves one CPU on a standard four-core runner for fixture subprocesses; the earlier `3 + 1` aggregate produced unrelated five-second contract failures in consecutive complete runs even though every focused file passed. The two native HMR suites and the CPU-bound read-card lazy-grammar suite run only in the process-bound project; their behavior and timeouts are unchanged. The grammar suite must preserve its existing five-second responsiveness contract. Related-test selection remains `vitest run --changed=origin/solar`, and the profile marks that gate `exclusive: true`: Code-as-Harness drains active ordinary gates before starting it and does not admit new work until it finishes. This preserves the two-slot DAG for ordinary checks while giving the complete timing-sensitive suite sole machine ownership.

The workflow uses a partial blob checkout, pnpm and Yarn caches, and cancellation of superseded runs. Required Solar pull-request jobs default to portable `ubuntu-24.04` and `windows-2025` runners, with their inner concurrency bounded for standard four-core capacity. The existing repository-variable selectors still permit an explicitly configured self-hosted pool, but normal correctness no longer depends on upstream organization runner labels. Pull-request CI remains the automatic commit-bound authority. The complete [fork adapter](2026-08-15-fork-branch-push-ci.md) remains available through manual dispatch for cross-platform diagnosis, but no longer duplicates every `codex/**` branch push.

The coverage lane additionally fixes `DSH_OXLINT_THREADS=1` and moves only `scripts/oxlint-contract.spec.ts` into a dependent tail gate. The instrumented and remaining exempt suites still run concurrently; after both finish, the Oxlint responsiveness contract runs on the idle runner. This adds only the focused tail rather than serializing the two long coverage paths. Test selection, coverage thresholds, and the five-second contract are unchanged.

The semantic snapshot aggregate now follows exhaustive coverage on the same runner instead of competing with the browser, lint, and documentation consumers. `DSH_SNAPSHOT_MAX_CONCURRENCY` controls both file workers and in-file concurrency, with two workers on a standard four-core host so real child processes and timer-based transport contracts retain CPU. The browser consumer lane still runs in parallel on its own runner; its scroll fixture carries enough paced chunks to guarantee that history loading and streaming overlap on supported hosted capacity without increasing any assertion timeout.

The Web aggregate preserves all 77 files but runs the Cordis dynamic-plugin lifecycle in a second Vitest process after the other 76 files. This gives define, mount, stop, and durable-log assertions a fresh runtime boundary while keeping the real browser interaction and exact golden comparison unchanged.

The native Windows inventory now extends its existing unsupported roster with only the three Unix-socket files. Resident SQLite lifecycle tests remain active; only their POSIX permission-bit assertions are conditional on a POSIX host. The exhaustive invariant topology and the real Claude hook subprocess integration each receive an explicit integration-test budget, and the one ACP closed-turn fixture uses a 250 ms scenario timeout so Windows timer granularity cannot replace the intended domain error with Vitest's generic wait error. No application timeout, retry, fallback, coverage threshold, or supported product path changes.

## Alternatives considered

**Increase HMR timeouts.** Rejected because focused stress passed and the failure was event loss under aggregate watcher pressure; waiting longer would hide rather than remove contention.

**Use polling or allow empty project selections.** Rejected because polling adds constant filesystem load and `--passWithNoTests` could turn an incorrect test partition into apparent success.

**Skip complete Code-as-Harness verification.** Rejected because optimization must preserve the same attested gate set and evidence semantics.

**Run both automatic fork push CI and pull-request CI.** Rejected because they repeat the same full evidence for one commit. The manual adapter preserves the diagnostic matrix without taxing the normal path.

## Consequences

Independent ordinary gates use a two-slot outer budget, while `related-tests` is the measured exclusive resource gate and native-watcher and lazy-grammar tests remain serialized inside Vitest. Gate output is emitted after each task completes, so concurrent logs remain readable. Standard runner lanes may execute longer than organization-specific larger runners, but they start without external runner provisioning and keep the public repository reproducible. A branch push without a pull request no longer receives the fork adapter's automatic verdict; opening or updating a pull request supplies the required authority, and the diagnostic matrix can still be dispatched manually.

## Verification

Contract tests pin the shared build dependency, prepared consumer commands, exact exclusive related-test command, worker budgets, Windows Unix-socket exclusions, partial checkout, caches, and absence of a second workflow-level source build. Governance runtime tests cover invalid and cyclic dependencies, transitive selection, bounded independent execution, exclusive execution, and dependency failure. Acceptance requires the full strict audit, monorepo verifier, complete Code-as-Harness verification and attestation, followed by the remote pull-request CI verdict for the exact commit.
